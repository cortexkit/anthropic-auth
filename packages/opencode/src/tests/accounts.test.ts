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
  addAccountPersistent,
  buildQuotaOperationError,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  FallbackAccountManager,
  fetchOAuthAccountProfile,
  fetchOAuthQuotaSnapshot,
  formatOAuthAccountTier,
  getAccountStatePath,
  getCache1hPersistentMode,
  getLogLevel,
  getOrCreatePrimeAuthLineageId,
  getPersistedLogLevel,
  getScopedQuotaWindowForModel,
  incrementPrimeUsagePersistent,
  isCacheKeepSubagentsEnabled,
  isCostZeroingEnabled,
  isFastModePersistentlyEnabled,
  isPermanentRefreshError,
  isPrimePersistentlyEnabled,
  type KillswitchThresholds,
  killswitchPassesPolicy,
  loadAccounts,
  type OAuthAccount,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  oauthProfileIsFresh,
  PROFILE_TTL_MS,
  QuotaManager,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  removeAccount,
  removeAccountPersistent,
  reorderAccounts,
  reorderAccountsPersistent,
  saveAccountState,
  saveAccounts,
  saveOAuthProfileState,
  setAccountEnabled,
  setAccountEnabledPersistent,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCacheKeepPersistentAlways,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setCacheKeepSubagentsEnabled,
  setFastModePersistentEnabled,
  setLogLevel,
  setLogLevelPersistent,
  setPrimePersistentEnabled,
  shouldFallbackStatus,
  tokenFingerprint,
  upsertAccount,
} from '@cortexkit/anthropic-auth-core'

let tempDir: string
let accountPath: string

function expectOAuthAccount(
  account: AccountStorage['accounts'][number] | undefined,
): OAuthAccount {
  expect(account?.type).toBe('oauth')
  return account as OAuthAccount
}

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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
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
      tokenFingerprint: tokenFingerprint('token'),
    })
    expect(formatOAuthAccountTier(profile)).toBe('Max 20x')
  })

  test('fetchOAuthAccountProfile normalizes the Team Max-5x capture', async () => {
    const profile = await fetchProfile(teamCapture)

    expect(profile).toEqual({
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 1234,
      tokenFingerprint: tokenFingerprint('token'),
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

  test('dedicated main and scoped fallback profiles survive sidecar load', async () => {
    const storage = baseStorage()
    const mainProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 100,
    }
    const fallbackProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 200,
    }
    storage.main = { ...storage.main!, profile: mainProfile }
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      refresh: 'refresh',
      profile: fallbackProfile,
    })

    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { mainProfile: true })
    const loaded = await loadAccounts(accountPath)

    expect(loaded?.main?.profile).toEqual(mainProfile)
    expect(expectOAuthAccount(loaded?.accounts[0]).profile).toEqual(
      fallbackProfile,
    )
  })

  test('profile runtime fields are omitted from anthropic-auth.json', async () => {
    const storage = baseStorage()
    storage.main = {
      ...storage.main!,
      profile: { tier: 'tier', orgType: 'org', checkedAt: 100 },
    }
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      refresh: 'refresh',
      profile: { tier: 'tier', orgType: 'org', checkedAt: 100 },
    })

    await saveAccounts(storage, accountPath)
    const config = JSON.parse(await readFile(accountPath, 'utf8'))

    expect(config.main.profile).toBeUndefined()
    expect(config.accounts[0].profile).toBeUndefined()
  })

  test('re-login does not retain a previous account profile', () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      refresh: 'old',
      profile: { tier: 'old', orgType: 'old', checkedAt: 100 },
    })

    upsertAccount(storage, { id: 'work', type: 'oauth', refresh: 'new' })

    expect(expectOAuthAccount(storage.accounts[0]).profile).toBeUndefined()
  })

  test('runtime merge clears a fallback profile when OAuth credentials rotate', async () => {
    const initial = baseStorage()
    initial.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      profile: {
        tier: 'old-tier',
        orgType: 'claude_team',
        checkedAt: 100,
        tokenFingerprint: tokenFingerprint('old-access'),
      },
    })
    await saveAccounts(initial, accountPath)

    const rotated = baseStorage()
    rotated.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
    })
    await saveAccounts(rotated, accountPath)

    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .profile,
    ).toBeUndefined()
  })

  test('runtime merge keeps a fallback profile when OAuth credentials match', async () => {
    const profile: OAuthAccountProfile = {
      tier: 'same-tier',
      orgType: 'claude_team',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('same-access'),
    }
    const initial = baseStorage()
    initial.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'same-access',
      refresh: 'same-refresh',
      profile,
    })
    await saveAccounts(initial, accountPath)

    const sameCredentials = baseStorage()
    sameCredentials.accounts.push({
      id: 'work',
      type: 'oauth',
      access: 'same-access',
      refresh: 'same-refresh',
    })
    await saveAccounts(sameCredentials, accountPath)

    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .profile,
    ).toEqual(profile)
  })

  test('delayed main profile clear preserves a newer profile for the same token', async () => {
    const accessToken = 'main-access'
    const expectedTokenFingerprint = tokenFingerprint(accessToken)
    const staleProfile: OAuthAccountProfile = {
      tier: 'old-tier',
      orgType: 'old-org',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('old-main-access'),
    }
    const freshProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 200,
      tokenFingerprint: expectedTokenFingerprint,
    }
    const storage = baseStorage()
    storage.main = { ...storage.main!, profile: staleProfile }
    await saveAccounts(storage, accountPath)
    await saveAccountState(storage, accountPath, { mainProfile: true })

    const processAView = await loadAccounts(accountPath)
    expect(processAView?.main?.profile).toEqual(staleProfile)
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'main',
          profile: undefined,
          expectedTokenFingerprint,
        },
        accountPath,
      ),
    ).toBe(true)
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'main',
          profile: freshProfile,
          expectedTokenFingerprint,
        },
        accountPath,
      ),
    ).toBe(true)

    const clearAccepted = await saveOAuthProfileState(
      {
        accountId: 'main',
        profile: undefined,
        expectedTokenFingerprint,
      },
      accountPath,
    )
    expect((await loadAccounts(accountPath))?.main?.profile).toEqual(
      freshProfile,
    )
    expect(clearAccepted).toBe(false)
  })

  test('delayed fallback profile clear preserves a newer profile for the same token', async () => {
    const accessToken = 'fallback-access'
    const expectedTokenFingerprint = tokenFingerprint(accessToken)
    const staleProfile: OAuthAccountProfile = {
      tier: 'old-tier',
      orgType: 'old-org',
      checkedAt: 100,
      tokenFingerprint: tokenFingerprint('old-fallback-access'),
    }
    const freshProfile: OAuthAccountProfile = {
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 200,
      tokenFingerprint: expectedTokenFingerprint,
    }
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work',
      type: 'oauth',
      access: accessToken,
      refresh: 'refresh',
      profile: staleProfile,
    })
    await saveAccounts(storage, accountPath)

    const processAView = await loadAccounts(accountPath)
    expect(expectOAuthAccount(processAView?.accounts[0]).profile).toEqual(
      staleProfile,
    )
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'work',
          profile: undefined,
          expectedTokenFingerprint,
        },
        accountPath,
      ),
    ).toBe(true)
    expect(
      await saveOAuthProfileState(
        {
          accountId: 'work',
          profile: freshProfile,
          expectedTokenFingerprint,
        },
        accountPath,
      ),
    ).toBe(true)

    const clearAccepted = await saveOAuthProfileState(
      {
        accountId: 'work',
        profile: undefined,
        expectedTokenFingerprint,
      },
      accountPath,
    )
    expect(
      expectOAuthAccount((await loadAccounts(accountPath))?.accounts[0])
        .profile,
    ).toEqual(freshProfile)
    expect(clearAccepted).toBe(false)
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

  test('persists across save/load round-trip', async () => {
    const storage = baseStorage()
    storage.costZeroing = { enabled: false }
    await saveAccounts(storage)
    const loaded = await loadAccounts()
    expect(loaded!.costZeroing).toEqual({ enabled: false })
    expect(isCostZeroingEnabled(loaded!)).toBe(false)
  })
})

describe('account storage', () => {
  test('saves and loads sidecar accounts', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
    })

    await saveAccounts(storage)

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.accounts[0].id).toBe('fallback-1')
    expect(rawConfig.accounts[0].access).toBeUndefined()
    expect(rawConfig.accounts[0].refresh).toBeUndefined()

    const rawState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(rawState.accounts['fallback-1'].access).toBe('access')
    expect(rawState.accounts['fallback-1'].refresh).toBe('refresh')

    await expect(loadAccounts()).resolves.toEqual(storage)
  })

  test('stores API fallback route secret in runtime state and endpoint in config', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'kie-opus',
      label: 'Kie Opus',
      type: 'api',
      apiKey: 'kie-key',
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })

    await saveAccounts(storage)

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.accounts[0]).toMatchObject({
      id: 'kie-opus',
      label: 'Kie Opus',
      type: 'api',
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })
    expect(rawConfig.accounts[0].apiKey).toBeUndefined()

    const rawState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(rawState.accounts['kie-opus'].apiKey).toBe('kie-key')

    await expect(loadAccounts()).resolves.toEqual(storage)
  })

  test('prefers newer legacy config OAuth credentials over stale runtime state', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'umut',
            label: 'umut',
            type: 'oauth',
            enabled: true,
            addedAt: 1,
            lastUsed: 2_000,
            access: 'new-access',
            refresh: 'new-refresh',
            expires: 3_000,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      getAccountStatePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          umut: {
            access: 'old-access',
            refresh: 'old-refresh',
            expires: 1_000,
            lastRefreshedAt: 1_000,
            lastRefreshError: {
              message: 'Claude OAuth refresh failed: 400 invalid_grant',
              checkedAt: 1_500,
              nextRetryAt: 99_999,
              status: 400,
              permanent: true,
            },
            lastQuotaRefreshError: {
              message: 'refresh backed off',
              checkedAt: 1_500,
            },
            quota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: 1_500,
              },
            },
          },
        },
      }),
      'utf8',
    )

    const loaded = await loadAccounts()
    const account = loaded?.accounts[0]
    expect(account?.type).toBe('oauth')
    if (account?.type !== 'oauth') throw new Error('expected oauth account')
    expect(account).toMatchObject({
      id: 'umut',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 3_000,
      lastUsed: 2_000,
      lastRefreshedAt: 2_000,
    })
    expect(account.lastRefreshError).toBeUndefined()
    expect(account.lastQuotaRefreshError).toBeUndefined()
    expect(account.quota).toBeUndefined()
  })

  test('keeps newer runtime OAuth credentials over older legacy config credentials', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'umut',
            label: 'umut',
            type: 'oauth',
            enabled: true,
            addedAt: 1,
            lastUsed: 500,
            access: 'old-config-access',
            refresh: 'old-config-refresh',
            expires: 500,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      getAccountStatePath(),
      JSON.stringify({
        version: 1,
        accounts: {
          umut: {
            access: 'new-state-access',
            refresh: 'new-state-refresh',
            expires: 2_000,
            lastRefreshedAt: 2_000,
          },
        },
      }),
      'utf8',
    )

    const loaded = await loadAccounts()
    expect(loaded?.accounts[0]).toMatchObject({
      id: 'umut',
      access: 'new-state-access',
      refresh: 'new-state-refresh',
      expires: 2_000,
      lastRefreshedAt: 2_000,
    })
  })

  test('drops API fallback routes with invalid base URLs on load', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'bad-api',
            type: 'api',
            baseURL: 'https://token@example.com/v1',
            enabled: true,
          },
          {
            id: 'good-api',
            type: 'api',
            baseURL: 'https://api.kie.ai/claude',
            enabled: true,
          },
        ],
      }),
      'utf8',
    )

    const loaded = await loadAccounts()
    expect(loaded?.accounts.map((account) => account.id)).toEqual(['good-api'])
  })

  test('runtime state saves do not rewrite user-editable config', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      checkIntervalMinutes: 20,
      mainQuota: {
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 123,
        },
      },
      mainQuotaCheckedAt: 123,
      mainQuotaToken: 'token-a',
    }
    await saveAccounts(storage)

    const staleRuntimeView = await loadAccounts()
    expect(staleRuntimeView).not.toBeNull()
    ;(staleRuntimeView as AccountStorage).quota = {
      ...(staleRuntimeView as AccountStorage).quota,
      checkIntervalMinutes: 5,
      mainQuota: {
        five_hour: {
          usedPercent: 22,
          remainingPercent: 78,
          checkedAt: 456,
        },
      },
      mainQuotaCheckedAt: 456,
      mainQuotaToken: 'token-b',
    }

    await saveAccountState(staleRuntimeView as AccountStorage, accountPath, {
      mainQuota: true,
    })

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.quota.checkIntervalMinutes).toBe(20)
    expect(rawConfig.quota.mainQuota).toBeUndefined()

    const loaded = await loadAccounts()
    expect(loaded?.quota?.checkIntervalMinutes).toBe(20)
    expect(loaded?.quota?.mainQuotaToken).toBe('token-b')
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(22)
  })

  test('generic saves preserve a newer persisted main profile', async () => {
    const staleStorage = baseStorage()
    await saveAccounts(staleStorage)

    const hydratedStorage = await loadAccounts()
    expect(hydratedStorage).not.toBeNull()
    ;(hydratedStorage as AccountStorage).main = {
      type: 'opencode',
      provider: 'anthropic',
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: 500,
        tokenFingerprint: tokenFingerprint('main-access'),
      },
    }
    await saveAccountState(hydratedStorage as AccountStorage, accountPath, {
      mainProfile: true,
    })

    await saveAccounts(staleStorage)

    expect((await loadAccounts())?.main?.profile).toEqual(
      hydratedStorage?.main?.profile,
    )
  })

  test('runtime state saves do not overwrite newer quota snapshots', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 500,
        },
      },
      mainQuotaCheckedAt: 500,
      mainQuotaToken: 'token-newer',
    }
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access-newer',
      refresh: 'refresh-newer',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 500,
        },
      },
    })
    await saveAccounts(storage)

    const staleRuntimeView = await loadAccounts()
    expect(staleRuntimeView).not.toBeNull()
    ;(staleRuntimeView as AccountStorage).quota = {
      ...(staleRuntimeView as AccountStorage).quota,
      mainQuota: {
        five_hour: {
          usedPercent: 99,
          remainingPercent: 1,
          checkedAt: 100,
        },
      },
      mainQuotaCheckedAt: 100,
      mainQuotaToken: 'token-older',
    }
    ;(staleRuntimeView as AccountStorage).accounts[0] = {
      ...((staleRuntimeView as AccountStorage).accounts[0] as OAuthAccount),
      access: 'access-older',
      refresh: 'refresh-older',
      quota: {
        five_hour: {
          usedPercent: 99,
          remainingPercent: 1,
          checkedAt: 100,
        },
      },
      lastQuotaRefreshError: {
        checkedAt: 100,
        nextRetryAt: 200,
        retryCount: 1,
        message: 'stale failure',
      },
    }

    await saveAccountState(staleRuntimeView as AccountStorage, accountPath, {
      mainQuota: true,
      accounts: true,
    })

    const loaded = await loadAccounts()
    expect(loaded?.quota?.mainQuotaToken).toBe('token-newer')
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(11)
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.access).toBe('access-newer')
    expect(account.refresh).toBe('refresh-newer')
    expect(account.quota?.five_hour?.usedPercent).toBe(20)
    expect(account.lastQuotaRefreshError).toBeUndefined()
  })

  test('equal-time stale saves do not overwrite a harvested header snapshot', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 25,
          remainingPercent: 75,
          checkedAt: 500,
        },
      },
    })
    await saveAccounts(storage)
    const harvestedView = await loadAccounts()
    const staleMarkUsedView = await loadAccounts()
    expect(harvestedView).not.toBeNull()
    expect(staleMarkUsedView).not.toBeNull()
    const harvested = expectOAuthAccount(harvestedView?.accounts[0])
    harvested.quota = {
      five_hour: {
        usedPercent: 78,
        remainingPercent: 22,
        checkedAt: 500,
      },
      source: 'headers',
      checkedAt: 500,
    }
    expectOAuthAccount(staleMarkUsedView?.accounts[0]).lastUsed = 501

    await saveAccountState(harvestedView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })
    await saveAccountState(staleMarkUsedView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.quota?.source).toBe('headers')
    expect(account.quota?.five_hour?.usedPercent).toBe(78)
    expect(account.lastUsed).toBe(501)
  })

  test('equal-time poll replaces headers and keeps scoped quota', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: 500,
        },
        source: 'headers',
        checkedAt: 500,
      },
    })
    await saveAccounts(storage)
    const pollView = await loadAccounts()
    const pollAccount = expectOAuthAccount(pollView?.accounts[0])
    pollAccount.quota = {
      five_hour: {
        usedPercent: 79,
        remainingPercent: 21,
        checkedAt: 500,
      },
      scoped: [
        {
          id: 'weekly-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 500,
        },
      ],
      source: 'poll',
      checkedAt: 500,
    }

    await saveAccountState(pollView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.quota?.source).toBe('poll')
    expect(account.quota?.scoped?.[0]?.id).toBe('weekly-fable')
  })

  test('equal-time header snapshot can replace another header snapshot', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: 500,
        },
        source: 'headers',
        checkedAt: 500,
      },
    })
    await saveAccounts(storage)
    const nextHeaderView = await loadAccounts()
    const nextHeader = expectOAuthAccount(nextHeaderView?.accounts[0])
    nextHeader.quota = {
      five_hour: {
        usedPercent: 80,
        remainingPercent: 20,
        checkedAt: 500,
      },
      source: 'headers',
      checkedAt: 500,
    }

    await saveAccountState(nextHeaderView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    expect(
      expectOAuthAccount(loaded?.accounts[0]).quota?.five_hour?.usedPercent,
    ).toBe(80)
  })

  test('main equal-time poll beats headers and source-less saves', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: 500,
        },
        source: 'headers',
        checkedAt: 500,
      },
      mainQuotaCheckedAt: 500,
      mainQuotaToken: 'token',
    }
    await saveAccounts(storage)
    const pollView = await loadAccounts()
    const sourceLessView = await loadAccounts()
    expect(pollView).not.toBeNull()
    expect(sourceLessView).not.toBeNull()
    ;(pollView as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 79,
        remainingPercent: 21,
        checkedAt: 500,
      },
      scoped: [
        {
          id: 'weekly-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt: 500,
        },
      ],
      source: 'poll',
      checkedAt: 500,
    }
    ;(sourceLessView as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 1,
        remainingPercent: 99,
        checkedAt: 500,
      },
      checkedAt: 500,
    }

    await saveAccountState(pollView as AccountStorage, accountPath, {
      mainQuota: true,
    })
    await saveAccountState(sourceLessView as AccountStorage, accountPath, {
      mainQuota: true,
    })

    const loaded = await loadAccounts()
    expect(loaded?.quota?.mainQuota?.source).toBe('poll')
    expect(loaded?.quota?.mainQuota?.scoped?.[0]?.id).toBe('weekly-fable')
  })

  test('fallback header persistence preserves newer poll-owned fields from disk', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 999,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        scoped: [
          {
            id: 'weekly-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 40,
            remainingPercent: 60,
            checkedAt: 900,
          },
        ],
        extraUsage: {
          used: { amountMinor: 500, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 1000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
        bindingWindow: 'weekly-fable',
        bindingWindowSource: 'poll',
        source: 'poll',
        checkedAt: 600,
      },
    })
    await saveAccounts(storage)
    const staleHeaderView = await loadAccounts()
    const account = expectOAuthAccount(staleHeaderView?.accounts[0])
    account.quota = {
      five_hour: {
        usedPercent: 78,
        remainingPercent: 22,
        checkedAt: 700,
      },
      seven_day: {
        usedPercent: 40,
        remainingPercent: 60,
        checkedAt: 700,
      },
      scoped: [],
      fallbackAdvised: true,
      bindingWindow: 'five_hour',
      bindingWindowSource: 'headers',
      source: 'headers',
      checkedAt: 700,
    }

    await saveAccountState(staleHeaderView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const merged = expectOAuthAccount(loaded?.accounts[0]).quota
    expect(merged?.five_hour?.usedPercent).toBe(78)
    expect(merged?.seven_day?.usedPercent).toBe(40)
    expect(merged?.scoped?.[0]?.id).toBe('weekly-fable')
    expect(merged?.extraUsage?.used.amountMinor).toBe(500)
    expect(merged?.bindingWindow).toBe('weekly-fable')
    expect(merged?.bindingWindowSource).toBe('poll')
  })

  test('main header persistence preserves newer poll-owned fields from disk', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 600,
        },
        scoped: [
          {
            id: 'weekly-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 40,
            remainingPercent: 60,
            checkedAt: 900,
          },
        ],
        extraUsage: {
          used: { amountMinor: 500, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 1000, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
        bindingWindow: 'weekly-fable',
        bindingWindowSource: 'poll',
        source: 'poll',
        checkedAt: 600,
      },
      mainQuotaToken: 'same-token',
    }
    await saveAccounts(storage)
    const staleHeaderView = await loadAccounts()
    ;(staleHeaderView as AccountStorage).quota!.mainQuota = {
      five_hour: {
        usedPercent: 78,
        remainingPercent: 22,
        checkedAt: 700,
      },
      seven_day: {
        usedPercent: 40,
        remainingPercent: 60,
        checkedAt: 700,
      },
      scoped: [],
      source: 'headers',
      checkedAt: 700,
    }
    ;(staleHeaderView as AccountStorage).quota!.mainQuotaCheckedAt = 700

    await saveAccountState(staleHeaderView as AccountStorage, accountPath, {
      mainQuota: true,
    })

    const loaded = await loadAccounts()
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
    expect(loaded?.quota?.mainQuota?.scoped?.[0]?.id).toBe('weekly-fable')
    expect(loaded?.quota?.mainQuota?.extraUsage?.used.amountMinor).toBe(500)
    expect(loaded?.quota?.mainQuota?.bindingWindow).toBe('weekly-fable')
  })

  test('fallback token rotation never rebinds the previous token quota', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_000,
      lastRefreshedAt: 100,
      quota: {
        five_hour: {
          usedPercent: 80,
          remainingPercent: 20,
          checkedAt: 500,
        },
        source: 'poll',
        checkedAt: 500,
      },
    })
    await saveAccounts(storage)
    const rotatedView = await loadAccounts()
    const rotated = expectOAuthAccount(rotatedView?.accounts[0])
    rotated.access = 'new-access'
    rotated.refresh = 'new-refresh'
    rotated.lastRefreshedAt = 600
    rotated.quota = {
      five_hour: {
        usedPercent: 5,
        remainingPercent: 95,
        checkedAt: 100,
      },
      source: 'headers',
      checkedAt: 100,
    }
    expect(rotated.access).not.toBe('old-access')

    await saveAccountState(rotatedView as AccountStorage, accountPath, {
      accounts: ['fallback-1'],
    })

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.access).toBe('new-access')
    expect(account.quota?.five_hour?.usedPercent).toBe(5)
    expect(account.quota?.source).toBe('headers')
  })

  test('runtime token updates drop source-less quota passthrough', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_000,
      lastRefreshedAt: 100,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 500,
        },
      },
    })
    await saveAccounts(storage)

    const refreshedRuntimeView = await loadAccounts()
    expect(refreshedRuntimeView).not.toBeNull()
    ;(refreshedRuntimeView as AccountStorage).accounts[0] = {
      ...((refreshedRuntimeView as AccountStorage).accounts[0] as OAuthAccount),
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 2_000,
      lastRefreshedAt: 600,
      quota: {
        five_hour: {
          usedPercent: 99,
          remainingPercent: 1,
          checkedAt: 100,
        },
      },
    }
    expect(
      expectOAuthAccount((refreshedRuntimeView as AccountStorage).accounts[0])
        .access,
    ).not.toBe('old-access')

    await saveAccountState(
      refreshedRuntimeView as AccountStorage,
      accountPath,
      {
        accounts: true,
      },
    )

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.access).toBe('new-access')
    expect(account.refresh).toBe('new-refresh')
    expect(account.lastRefreshedAt).toBe(600)
    expect(account.quota).toBeUndefined()
  })

  test('malformed config file throws a clear error', async () => {
    await writeFile(accountPath, '{nope', 'utf8')
    await expect(loadAccounts()).rejects.toThrow('corrupt or unreadable')
  })

  test('refresh file lock allows only one holder', async () => {
    let now = 1_000
    const first = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(first).not.toBeNull()

    await expect(
      acquireRefreshFileLock({
        name: 'test-refresh',
        ttlMs: 60_000,
        path: accountPath,
        now: () => now,
      }),
    ).resolves.toBeNull()

    await first?.release()
    const second = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(second).not.toBeNull()
    await second?.release()

    const stale = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(stale).not.toBeNull()
    now += 60_001
    const afterStale = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
      now: () => now,
    })
    expect(afterStale).not.toBeNull()
    await afterStale?.release()
  })

  test('refresh file lock stale-marker steal has a single winner under forced recreate race', async () => {
    const name = 'test-refresh-forced-stale-steal'
    const now = 100_000
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
      now: () => now,
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
      now: () => now,
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
      const now = 1_000_000 + round * 20_000
      await seedStaleRefreshLock(name, now, ttlMs)

      const locks = await Promise.all(
        Array.from({ length: contenders }, () =>
          acquireRefreshFileLock({
            name,
            ttlMs,
            path: accountPath,
            now: () => now,
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
      const now = 1_000
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
            now: () => now,
          }),
        ),
      )

      expect(results.every((r) => r === null)).toBe(true)

      await expect(stat(`${lockPath}.evicting`)).rejects.toThrow()
    })
  })

  test('preserves relay config when saving storage loaded by older code', async () => {
    await writeFile(
      accountPath,
      JSON.stringify(
        {
          ...baseStorage(),
          relay: {
            enabled: true,
            url: 'https://relay.example.workers.dev',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const staleStorage = baseStorage()
    staleStorage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
    })

    await saveAccounts(staleStorage)

    const raw = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(raw.relay).toEqual({
      enabled: true,
      url: 'https://relay.example.workers.dev',
      token: 'relay-token',
      fallbackToDirect: true,
      transport: 'websocket',
    })
    expect(raw.accounts).toHaveLength(1)
  })

  test('uses default fallback statuses when not configured', () => {
    expect(shouldFallbackStatus(429, null)).toBe(true)
    expect(shouldFallbackStatus(500, null)).toBe(false)
  })

  test('persists claudeCache enabled state and mode', async () => {
    await setCache1hPersistentEnabled(true)
    let saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: true, mode: 'explicit' })
    expect(getCache1hPersistentMode(saved)).toBe('explicit')

    await setCache1hPersistentMode('hybrid')
    saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: true, mode: 'hybrid' })
    expect(getCache1hPersistentMode(saved)).toBe('hybrid')

    await setCache1hPersistentEnabled(false)
    saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: false, mode: 'hybrid' })
  })

  test('persists cacheKeep window', async () => {
    const storage = await setCacheKeepPersistentWindow(9, 23)
    expect(storage.cacheKeep).toEqual({
      enabled: true,
      always: false,
      startHour: 9,
      endHour: 23,
    })
    const disabled = await setCacheKeepPersistentEnabled(false)
    expect(disabled.cacheKeep).toEqual({
      enabled: false,
      always: false,
      startHour: 9,
      endHour: 23,
    })
  })

  test('persists cacheKeep always mode, preserves subagents, and clears the old window', async () => {
    await setCacheKeepSubagentsEnabled(true)
    const windowed = await setCacheKeepPersistentWindow(9, 23)
    expect(windowed.cacheKeep?.subagents).toBe(true)
    const storage = await setCacheKeepPersistentAlways()
    expect(storage.cacheKeep).toEqual({
      enabled: true,
      always: true,
      subagents: true,
    })
    expect((await loadAccounts())?.cacheKeep).toEqual({
      enabled: true,
      always: true,
      subagents: true,
    })
  })

  test('persists and reads cacheKeep subagents toggle', async () => {
    const storage = await setCacheKeepSubagentsEnabled(true)
    expect(storage.cacheKeep?.subagents).toBe(true)
    expect(isCacheKeepSubagentsEnabled(storage)).toBe(true)

    const disabled = await setCacheKeepSubagentsEnabled(false)
    expect(disabled.cacheKeep?.subagents).toBe(false)
    expect(isCacheKeepSubagentsEnabled(disabled)).toBe(false)

    expect(isCacheKeepSubagentsEnabled(null)).toBe(false)
  })

  test('persists claudeFast enabled state', async () => {
    await setFastModePersistentEnabled(true)
    let saved = await loadAccounts()

    expect(saved?.claudeFast).toEqual({ enabled: true })
    expect(isFastModePersistentlyEnabled(saved)).toBe(true)

    await setFastModePersistentEnabled(false)
    saved = await loadAccounts()

    expect(saved?.claudeFast).toEqual({ enabled: false })
    expect(isFastModePersistentlyEnabled(saved)).toBe(false)
  })

  test('returns null when neither config nor state file exists', async () => {
    await expect(loadAccounts()).resolves.toBeNull()
  })

  test('reads runtime state when config file is absent (no fallback accounts)', async () => {
    const statePath = getAccountStatePath(accountPath)
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        main: {
          refreshLeaseId: 'lease-abc',
          refreshLeaseUntil: 9_999_999_999_999,
          refreshLeaseTokenHash: 'hash-xyz',
          quota: {
            five_hour: {
              usedPercent: 33,
              remainingPercent: 67,
              checkedAt: 777,
            },
          },
          quotaCheckedAt: 777,
          quotaToken: 'token-state-only',
        },
      }),
      'utf8',
    )

    // Config file must NOT exist for this scenario.
    await expect(stat(accountPath)).rejects.toThrow()

    const loaded = await loadAccounts()
    expect(loaded).not.toBeNull()
    expect(loaded?.accounts).toEqual([])
    expect(loaded?.refresh?.mainRefreshLeaseId).toBe('lease-abc')
    expect(loaded?.refresh?.mainRefreshLeaseUntil).toBe(9_999_999_999_999)
    expect(loaded?.refresh?.mainRefreshLeaseTokenHash).toBe('hash-xyz')
    expect(loaded?.quota?.mainQuotaToken).toBe('token-state-only')
    expect(loaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(33)
  })

  test('lease written via saveAccountState is visible to loadAccounts without a config file', async () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
      refresh: {
        mainRefreshLeaseId: 'lease-from-save',
        mainRefreshLeaseUntil: 9_999_999_999_999,
        mainRefreshLeaseTokenHash: 'token-hash-from-save',
      },
    }
    await saveAccountState(storage, accountPath, { mainRefresh: true })

    // saveAccountState must not have created the config file.
    await expect(stat(accountPath)).rejects.toThrow()

    const loaded = await loadAccounts()
    expect(loaded?.refresh?.mainRefreshLeaseId).toBe('lease-from-save')
    expect(loaded?.refresh?.mainRefreshLeaseTokenHash).toBe(
      'token-hash-from-save',
    )
  })
})

describe('FallbackAccountManager', () => {
  test('refreshes expired fallback tokens and persists rotation', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
      quota: {
        five_hour: { usedPercent: 1, remainingPercent: 99, checkedAt: 900 },
        seven_day: { usedPercent: 2, remainingPercent: 98, checkedAt: 900 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        expect(body.refresh_token).toBe('old-refresh')
        expect(new Headers(init?.headers).get('content-type')).toBe(
          'application/json',
        )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()
    expect(accounts[0]?.access).toBe('new-access')

    const saved = await loadAccounts()
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('new-refresh')
    expect(expectOAuthAccount(saved?.accounts[0]).expires).toBe(3_601_000)
    expect(expectOAuthAccount(saved?.accounts[0]).lastRefreshedAt).toBe(1_000)
  })

  test('filters fallback accounts with exhausted matching scoped model quota', async () => {
    const storage = baseStorage()
    storage.accounts.push(
      {
        id: 'fable-empty',
        type: 'oauth',
        access: 'empty-access',
        refresh: 'empty-refresh',
        expires: Date.now() + 5 * 60 * 60 * 1000,
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            checkedAt: 1_000,
          },
          seven_day: {
            usedPercent: 0,
            remainingPercent: 100,
            checkedAt: 1_000,
          },
          scoped: [
            {
              id: 'claude-weekly-scoped-fable',
              title: 'Fable only',
              modelName: 'Fable',
              usedPercent: 100,
              remainingPercent: 0,
              checkedAt: 1_000,
            },
          ],
        },
      },
      {
        id: 'fable-ok',
        type: 'oauth',
        access: 'ok-access',
        refresh: 'ok-refresh',
        expires: Date.now() + 5 * 60 * 60 * 1000,
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            checkedAt: 1_000,
          },
          seven_day: {
            usedPercent: 0,
            remainingPercent: 100,
            checkedAt: 1_000,
          },
          scoped: [
            {
              id: 'claude-weekly-scoped-fable',
              title: 'Fable only',
              modelName: 'Fable',
              usedPercent: 10,
              remainingPercent: 90,
              checkedAt: 1_000,
            },
          ],
        },
      },
    )
    await saveAccounts(storage)

    const manager = new FallbackAccountManager({ now: () => 1_000 })

    expect(
      (
        await manager.getUsableFallbackAccounts(undefined, {
          modelId: 'claude-fable-5',
        })
      ).map((account) => account.id),
    ).toEqual(['fable-ok'])
    expect(
      (
        await manager.getUsableFallbackAccounts(undefined, {
          modelId: 'claude-opus-4-8',
        })
      ).map((account) => account.id),
    ).toEqual(['fable-empty', 'fable-ok'])
  })

  test('preserves an empty scoped quota array through save/load when scoped is the only quota key', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'empty-scoped-only',
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: { scoped: [] },
    })
    await saveAccounts(storage)

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.quota).toBeDefined()
    expect(account.quota?.scoped).toBeDefined()
    expect(account.quota?.scoped).toEqual([])
  })

  test('preserves an empty scoped quota array alongside five_hour', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'empty-scoped-with-five-hour',
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: 1_000,
        },
        scoped: [],
      },
    })
    await saveAccounts(storage)

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(loaded?.accounts[0])
    expect(account.quota?.five_hour?.usedPercent).toBe(10)
    expect(account.quota?.scoped).toBeDefined()
    expect(account.quota?.scoped).toEqual([])
  })

  test('routing predicate treats empty scoped array as not exhausted (invariant lock)', () => {
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 10,
        remainingPercent: 90,
        checkedAt: 1_000,
      },
      seven_day: {
        usedPercent: 5,
        remainingPercent: 95,
        checkedAt: 1_000,
      },
      scoped: [],
    }
    expect(quotaSnapshotModelScopeIsExhausted(quota, 'claude-fable-5')).toBe(
      false,
    )
    expect(quotaSnapshotPassesModelScope(quota, 'claude-fable-5')).toBe(true)
    expect(quotaSnapshotPassesModelScope(quota, 'claude-opus-4-8')).toBe(true)
  })

  test('mergeAccountRuntimeState: windowless {scoped:[]} replaces stale exhausted-Fable quota', async () => {
    // Persist an exhausted-Fable scoped window at T1, then save a windowless
    // empty-scoped snapshot stamped T2 > T1. mergeAccountRuntimeState must NOT
    // treat the empty snapshot as stale and resurrect the old Fable window —
    // loadAccounts must return scoped: [].
    const accountId = 'merge-empty-scoped'
    const T1 = 1_000
    const T2 = 2_000

    const first = baseStorage()
    first.accounts.push({
      id: accountId,
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: T1,
        },
        seven_day: {
          usedPercent: 15,
          remainingPercent: 85,
          checkedAt: T1,
        },
        scoped: [
          {
            id: 'claude-weekly-scoped-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: T1,
          },
        ],
      },
    })
    await saveAccounts(first)

    const second = baseStorage()
    second.accounts.push({
      id: accountId,
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: { scoped: [], checkedAt: T2 },
    })
    await saveAccounts(second)

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(
      loaded?.accounts.find((entry) => entry.id === accountId),
    )
    expect(account.quota?.scoped).toEqual([])
  })

  test('mergeAccountRuntimeState: real promo-end path lands empty scoped', async () => {
    // Reachable-path lock: persist an account with five_hour/seven_day + a
    // Fable scoped window at T1, then save the post-promo snapshot (5h/7d at
    // T2, scoped: [], top-level checkedAt: T2). Loaded quota.scoped must be [].
    const accountId = 'merge-promo-end'
    const T1 = 1_000
    const T2 = 2_000

    const first = baseStorage()
    first.accounts.push({
      id: accountId,
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: T1,
        },
        seven_day: {
          usedPercent: 15,
          remainingPercent: 85,
          checkedAt: T1,
        },
        scoped: [
          {
            id: 'claude-weekly-scoped-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 42,
            remainingPercent: 58,
            checkedAt: T1,
          },
        ],
      },
    })
    await saveAccounts(first)

    const second = baseStorage()
    second.accounts.push({
      id: accountId,
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 25,
          remainingPercent: 75,
          checkedAt: T2,
        },
        seven_day: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: T2,
        },
        scoped: [],
        checkedAt: T2,
      },
    })
    await saveAccounts(second)

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(
      loaded?.accounts.find((entry) => entry.id === accountId),
    )
    expect(account.quota?.scoped).toEqual([])
  })

  test('top-level checkedAt round-trips through save/load', async () => {
    const storage = baseStorage()
    const stampedAt = 1_234_567
    storage.accounts.push({
      id: 'with-checked-at',
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60 * 60 * 1000,
      quota: {
        five_hour: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: stampedAt,
        },
        checkedAt: stampedAt,
      },
    })
    await saveAccounts(storage)

    const loaded = await loadAccounts()
    const account = expectOAuthAccount(
      loaded?.accounts.find((entry) => entry.id === 'with-checked-at'),
    )
    expect(account.quota?.checkedAt).toBe(stampedAt)
  })

  test('refreshes fallback tokens within the four-hour minimum window', async () => {
    const storage = baseStorage()
    storage.refresh = {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 30,
    }
    const now = Date.now()
    storage.accounts.push({
      id: 'fallback-early',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: now + 3 * 60 * 60_000,
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: any) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => now,
    })

    await manager.refreshDueAccounts()

    const saved = await loadAccounts()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('new-refresh')
  })

  test('refresh backoff retry count resets after token rotation', () => {
    const first = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1_000,
      refreshToken: 'old-refresh',
    })
    const second = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: first.nextRetryAt ?? 2_000,
      refreshToken: 'old-refresh',
      previous: first,
    })
    const afterRelogin = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: second.nextRetryAt ?? 3_000,
      refreshToken: 'new-refresh',
      previous: second,
    })

    expect(second.retryCount).toBe(2)
    expect(afterRelogin.retryCount).toBe(1)
  })

  test('backs off failed fallback refreshes instead of retrying every pass', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'rate-limited',
      type: 'oauth',
      access: 'expired-access',
      refresh: 'old-refresh',
      expires: 1,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_error', message: 'Rate limited' },
          }),
          { status: 429 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    await manager.refreshDueAccounts()
    await manager.refreshDueAccounts()
    await manager.refreshQuotaForDueAccounts()

    const saved = await loadAccounts()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      expectOAuthAccount(saved?.accounts[0]).lastRefreshError?.nextRetryAt,
    ).toBeGreaterThan(2_000)
    expect(
      expectOAuthAccount(saved?.accounts[0]).lastRefreshError?.retryCount,
    ).toBe(1)
  })

  test('preserves existing refresh token when refresh response omits rotation', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
    })

    await manager.refreshDueAccounts()

    const saved = await loadAccounts()
    expect(expectOAuthAccount(saved?.accounts[0]).access).toBe('new-access')
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('old-refresh')
    expect(expectOAuthAccount(saved?.accounts[0]).lastRefreshedAt).toBe(1_000)
  })

  test('re-reads latest stored token before refreshing stale snapshots', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
    })
    await saveAccounts(storage)

    const manager = new FallbackAccountManager({
      fetchImpl: mock(() => {
        throw new Error('refresh should not be called')
      }) as unknown as typeof fetch,
      now: () => 2_000,
    })

    const stale = await loadAccounts()
    if (!stale) throw new Error('missing fixture storage')

    const newer = baseStorage()
    newer.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      expires: 20_000_000,
    })
    await saveAccounts(newer)

    const refreshed = await manager.refreshAccount(
      expectOAuthAccount(stale.accounts[0]),
      stale,
    )

    expect(refreshed.access).toBe('fresh-access')
    expect(expectOAuthAccount(stale.accounts[0]).refresh).toBe('fresh-refresh')
  })

  test('serializes concurrent fallback refreshes across manager instances', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
    })
    await saveAccounts(storage)

    let releaseRefresh!: () => void
    const refreshStarted = Promise.withResolvers<void>()
    const refreshCanFinish = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let calls = 0
    const fetchImpl = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1
        const call = calls
        const body = JSON.parse(String(init?.body))
        expect(body.refresh_token).toBe('old-refresh')
        refreshStarted.resolve()
        await refreshCanFinish
        if (call > 1) {
          return new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Refresh token not found or invalid',
            }),
            { status: 400 },
          )
        }
        return new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 28_800,
          }),
          { status: 200 },
        )
      },
    ) as unknown as typeof fetch

    const managerA = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })
    const managerB = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const first = managerA.refreshDueAccounts()
    await refreshStarted.promise
    const second = managerB.refreshDueAccounts()
    releaseRefresh()
    await Promise.all([first, second])

    const saved = await loadAccounts()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(expectOAuthAccount(saved?.accounts[0]).access).toBe('new-access')
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('new-refresh')
    expect(
      expectOAuthAccount(saved?.accounts[0]).lastRefreshError,
    ).toBeUndefined()
  })

  test('starts an immediate background refresh pass for unused expired fallbacks', async () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, enabled: false }
    storage.accounts.push({
      id: 'unused-expired',
      type: 'oauth',
      access: 'expired-access',
      refresh: 'old-refresh',
      expires: 1,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    manager.startBackgroundRefresh()
    let saved: AccountStorage | null = null
    for (let attempt = 0; attempt < 50; attempt++) {
      saved = await loadAccounts()
      if (expectOAuthAccount(saved?.accounts[0]).access === 'fresh-access')
        break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    manager.stopBackgroundRefresh()

    expect(expectOAuthAccount(saved?.accounts[0]).access).toBe('fresh-access')
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('fresh-refresh')
    expect(fetchImpl).toHaveBeenCalled()
  })

  test('skips accounts below configured quota thresholds', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'low-quota',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 20_000_000,
      quota: {
        five_hour: { usedPercent: 95, remainingPercent: 5, checkedAt: 1_000 },
        seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt: 1_000 },
      },
    })
    await saveAccounts(storage)

    const manager = new FallbackAccountManager({ now: () => 1_001 })
    await expect(manager.getUsableFallbackAccounts()).resolves.toEqual([])
  })

  test('checks stale quota and keeps accounts above threshold', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fresh-quota',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 20_000_000,
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: string | URL | Request) => {
      expect(String(input)).toContain('/api/oauth/usage')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 25, resets_at: '2026-01-01T00:00:00Z' },
            seven_day: { utilization: 50, resets_at: '2026-01-07T00:00:00Z' },
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.quota?.five_hour?.remainingPercent).toBe(75)
  })

  test('does not overwrite a concurrently refreshed token after quota fetch', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'concurrent-refresh',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 20_000_000,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/api/oauth/usage')
      const latest = await loadAccounts()
      expect(latest).not.toBeNull()
      ;(latest as AccountStorage).accounts[0] = {
        ...((latest as AccountStorage).accounts[0] as OAuthAccount),
        access: 'new-access',
        refresh: 'new-refresh',
        expires: 30_000_000,
        lastRefreshedAt: 2_000,
      }
      await saveAccountState(latest as AccountStorage, accountPath, {
        accounts: true,
      })
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 25, resets_at: '2026-01-01T00:00:00Z' },
          seven_day: { utilization: 50, resets_at: '2026-01-07T00:00:00Z' },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const result = await manager.refreshQuotaForAllAccounts()

    expect(result.errors).toEqual([])
    const saved = await loadAccounts()
    const account = expectOAuthAccount(saved?.accounts[0])
    expect(account.access).toBe('new-access')
    expect(account.refresh).toBe('new-refresh')
    expect(account.quota).toBeUndefined()
  })

  test('persists token rotation from background quota refresh even when quota is still fresh', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'almost-expired-fresh-quota',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_600_000,
      quota: {
        five_hour: { usedPercent: 1, remainingPercent: 99, checkedAt: 1_000 },
        seven_day: { usedPercent: 2, remainingPercent: 98, checkedAt: 1_000 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe('https://platform.claude.com/v1/oauth/token')
        const body = JSON.parse(String(init?.body))
        expect(body.refresh_token).toBe('old-refresh')
        expect(new Headers(init?.headers).get('content-type')).toBe(
          'application/json',
        )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
    })

    await manager.refreshQuotaForDueAccounts()

    const saved = await loadAccounts()
    expect(expectOAuthAccount(saved?.accounts[0]).access).toBe('new-access')
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('new-refresh')
    expect(expectOAuthAccount(saved?.accounts[0]).lastRefreshedAt).toBe(1_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('refreshQuotaForDueAccounts fires onFallbackStorageChanged when storage changes', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'idle-stale',
      type: 'oauth',
      access: 'idle-access',
      refresh: 'idle-refresh',
      expires: 20_000_000,
      quota: {
        // checkedAt far in the past → stale → will be refreshed this pass.
        five_hour: { usedPercent: 5, remainingPercent: 95, checkedAt: 1 },
        seven_day: { usedPercent: 5, remainingPercent: 95, checkedAt: 1 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 40 },
            seven_day: { utilization: 30 },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    let fired = 0
    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 50_000_000, // well past checkedAt → stale
      onFallbackStorageChanged: () => {
        fired += 1
      },
    })

    await manager.refreshQuotaForDueAccounts()

    expect(fetchImpl).toHaveBeenCalled()
    expect(fired).toBe(1)
  })

  test('refreshes fallback token and retries quota check after stale access token 401', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'stale-access',
      type: 'oauth',
      access: 'old-access',
      refresh: 'refresh-token',
      expires: 20_000_000,
    })
    await saveAccounts(storage)

    const seen: string[] = []
    const fetchImpl = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/oauth/usage')) {
          seen.push(new Headers(init?.headers).get('authorization') ?? '')
          if (seen.length === 1) {
            return Promise.resolve(new Response('expired', { status: 401 }))
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 9 },
              }),
              { status: 200 },
            ),
          )
        }

        expect(url).toBe('https://platform.claude.com/v1/oauth/token')
        const body = JSON.parse(String(init?.body))
        expect(body.refresh_token).toBe('refresh-token')
        expect(new Headers(init?.headers).get('content-type')).toBe(
          'application/json',
        )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'fresh-access',
              refresh_token: 'fresh-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.access).toBe('fresh-access')
    expect(accounts[0]?.quota?.seven_day?.remainingPercent).toBe(91)
    expect(seen).toEqual(['Bearer old-access', 'Bearer fresh-access'])

    const saved = await loadAccounts()
    expect(expectOAuthAccount(saved?.accounts[0]).refresh).toBe('fresh-refresh')
  })

  test('uses cached passing quota when a stale quota refresh is rate limited', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'stale-good-quota',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 20_000_000,
      quota: {
        five_hour: {
          usedPercent: 30,
          remainingPercent: 70,
          checkedAt: 1_000,
          resetsAt: '2099-01-01T00:00:00Z',
        },
        seven_day: {
          usedPercent: 62,
          remainingPercent: 38,
          checkedAt: 1_000,
          resetsAt: '2099-01-01T00:00:00Z',
        },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_error', message: 'Rate limited' },
          }),
          { status: 429 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 10 * 60_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(accounts.map((account) => account.id)).toEqual(['stale-good-quota'])
  })

  test('uses cached passing quota when a stale quota refresh is already in progress', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'stale-good-quota',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 20_000_000,
      quota: {
        five_hour: {
          usedPercent: 30,
          remainingPercent: 70,
          checkedAt: 1_000,
          resetsAt: '2099-01-01T00:00:00Z',
        },
        seven_day: {
          usedPercent: 62,
          remainingPercent: 38,
          checkedAt: 1_000,
          resetsAt: '2099-01-01T00:00:00Z',
        },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() => {
      throw new Error('Quota refresh is already in progress')
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 10 * 60_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(accounts.map((account) => account.id)).toEqual(['stale-good-quota'])
  })

  test('does not use cached failing quota when a stale quota refresh is rate limited', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'stale-low-quota',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 20_000_000,
      quota: {
        five_hour: {
          usedPercent: 95,
          remainingPercent: 5,
          checkedAt: 1_000,
          resetsAt: '2099-01-01T00:00:00Z',
        },
        seven_day: {
          usedPercent: 62,
          remainingPercent: 38,
          checkedAt: 1_000,
          resetsAt: '2099-01-01T00:00:00Z',
        },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { type: 'rate_limit_error', message: 'Rate limited' },
          }),
          { status: 429 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 10 * 60_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(accounts).toEqual([])
  })

  test('skips fresh quota refresh and clears stale quota errors', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fresh-quota-with-old-error',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 20_000_000,
      quota: {
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: 1_900 },
        seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt: 1_900 },
      },
      lastQuotaRefreshError: {
        message: 'Claude quota check failed: 429 — rate limited',
        checkedAt: 1_800,
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() => {
      throw new Error('fresh quota should not be refetched')
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const result = await manager.refreshQuotaForAllAccounts()

    expect(result.errors).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    const saved = await loadAccounts()
    expect(
      expectOAuthAccount(saved?.accounts[0]).quota?.five_hour?.remainingPercent,
    ).toBe(90)
    expect(
      expectOAuthAccount(saved?.accounts[0]).lastQuotaRefreshError,
    ).toBeUndefined()
  })

  test('returns refresh errors from explicit quota refresh', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'invalid-refresh',
      type: 'oauth',
      access: 'expired-access',
      refresh: 'bad-refresh',
      expires: 1,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(new Response('invalid_grant', { status: 400 })),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const result = await manager.refreshQuotaForAllAccounts()
    expect(
      expectOAuthAccount(result.storage?.accounts[0]).quota,
    ).toBeUndefined()
    expect(result.errors).toEqual([
      {
        accountId: 'invalid-refresh',
        message: 'Claude OAuth refresh failed: 400 — invalid_grant',
      },
    ])
    const saved = await loadAccounts()
    expect(
      expectOAuthAccount(saved?.accounts[0]).lastQuotaRefreshError?.message,
    ).toBe('Claude OAuth refresh failed: 400 — invalid_grant')
  })

  test('force refreshes fresh accounts and persists the new quota', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fresh-but-forced',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 20_000_000,
      // Fresh quota — would normally be skipped by the staleness gate.
      quota: {
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: 1_900 },
        seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt: 1_900 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 70 },
            seven_day: { utilization: 30 },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({ fetchImpl, now: () => 2_000 })

    // force: true bypasses the staleness skip and fetches anyway.
    const result = await manager.refreshQuotaForAllAccounts({ force: true })

    expect(result.errors).toEqual([])
    expect(fetchImpl).toHaveBeenCalled()
    // Refreshed numbers are PERSISTED to disk (regression guard for #2).
    const saved = await loadAccounts()
    expect(
      expectOAuthAccount(saved?.accounts[0]).quota?.five_hour?.remainingPercent,
    ).toBe(30)
    expect(
      expectOAuthAccount(saved?.accounts[0]).quota?.seven_day?.remainingPercent,
    ).toBe(70)
  })

  test('fallback policy uses the QuotaManager cache, not stale storage quota', async () => {
    // Regression: an active-route refresh updates only the QM cache. Selection
    // must evaluate quota policy from that cache (single source of truth), not
    // the older storage account.quota, or it routes to an exhausted account.
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'fallback-access',
      refresh: 'fallback-refresh',
      expires: Date.now() + 5 * 60 * 60_000,
      // Storage says PASSING (100% remaining).
      quota: {
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: 900 },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: 900 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() => {
      throw new Error('should not fetch — QM entry is fresh')
    }) as unknown as typeof fetch
    const qm = new QuotaManager({ storage, fetchImpl, now: () => 1_000 })
    // Active-route refresh left a FRESH but EXHAUSTED entry in the QM cache.
    qm.setFallback(
      'fallback-1',
      {
        quota: {
          five_hour: {
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: 1_000,
          },
          seven_day: {
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: 1_000,
          },
        },
        refreshAfter: 1_000 + 10 * 60_000,
        checkedAt: 1_000,
      },
      'fallback-access',
    )

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
      quotaManager: qm,
    })
    const accounts = await manager.getUsableFallbackAccounts(storage)
    // QM cache is exhausted → account must NOT be usable (was usable when policy
    // read the stale storage quota).
    expect(accounts.map((a) => a.id)).not.toContain('fallback-1')
  })

  test('re-login (token change) invalidates a fresh fallback cache entry', async () => {
    // Regression: a same-id re-login changes the access token. The token-bound
    // fallback cache entry from the old token must be treated as stale so the
    // new credentials trigger a refetch instead of reusing the old quota.
    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 10 },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    const qm = new QuotaManager({ storage: null, fetchImpl, now: () => 2_000 })

    // Cache populated by the OLD token (binds its fingerprint), entry is fresh.
    await qm.refreshFallback('fallback-1', 'old-access')
    expect(qm.isFallbackStale('fallback-1', 'old-access')).toBe(false)

    // Same account id, NEW token (re-login): entry is invalidated → stale.
    expect(qm.isFallbackStale('fallback-1', 'new-access')).toBe(true)
    expect(qm.getFallback('fallback-1', 'new-access')).toBeNull()
  })

  test('re-login invalidates fallback cache seeded from persisted quota', async () => {
    // Regression: seedFallbackQuota used to write a tokenless QuotaManager entry.
    // A still-running plugin process could then reuse old same-label quota after
    // CLI re-login cleared account.quota on disk.
    const storage = baseStorage()
    storage.accounts.push({
      id: 'same-label',
      label: 'same-label',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 30_000_000,
      quota: {
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: 1_900 },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: 1_900 },
      },
    })

    const quotaProbeTokens: string[] = []
    const fetchImpl = mock((_: string | URL | Request, init?: RequestInit) => {
      quotaProbeTokens.push(
        new Headers(init?.headers).get('authorization') ?? '',
      )
      return Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 10 },
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch
    const qm = new QuotaManager({ storage, fetchImpl, now: () => 2_000 })
    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
      quotaManager: qm,
    })

    // First selection seeds the old persisted quota into QuotaManager.
    expect(
      (await manager.getUsableFallbackAccounts(storage)).map((a) => a.id),
    ).toContain('same-label')
    expect(quotaProbeTokens).toEqual([])

    // Simulate same-label re-login in a still-running process. CLI upsert clears
    // quota/error metadata for the stored account.
    storage.accounts[0] = {
      id: 'same-label',
      label: 'same-label',
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 30_000_000,
      enabled: true,
      addedAt: 2_000,
      lastUsed: 2_000,
    }

    expect(
      (await manager.getUsableFallbackAccounts(storage)).map((a) => a.id),
    ).toContain('same-label')
    expect(quotaProbeTokens).toEqual(['Bearer new-access'])
    expect(
      expectOAuthAccount(storage.accounts[0]).quota?.five_hour
        ?.remainingPercent,
    ).toBe(90)
  })
})

describe('buildRefreshOperationError', () => {
  test('uses Retry-After when available on 429', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', '120')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      refreshToken: 'test-token',
    })
    expect(result.nextRetryAt).toBe(1000000 + 120_000)
  })

  test('falls back to exponential backoff when no Retry-After', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      refreshToken: 'test-token',
    })
    expect(result.nextRetryAt).toBe(1000000 + 5 * 60_000)
  })

  test('captures the error status on the operation error', () => {
    const error = new ClaudeOAuthRefreshError(400, 'invalid_grant')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      refreshToken: 'test-token',
    })
    expect(result.status).toBe(400)
  })

  test('captures duck-typed status when no ClaudeOAuthRefreshError', () => {
    const result = buildRefreshOperationError({
      error: { status: 429 },
      now: 1000000,
      refreshToken: 'test-token',
    })
    expect(result.status).toBe(429)
  })

  test('sets permanent true only for 400 invalid_grant', () => {
    const dead = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: 1000000,
      refreshToken: 't',
    })
    expect(dead.permanent).toBe(true)
  })

  test('sets permanent false for retry-exhausted transient (no status)', () => {
    const exhausted = buildRefreshOperationError({
      error: new Error('Token refresh exhausted all retries'),
      now: 1000000,
      refreshToken: 't',
    })
    expect(exhausted.permanent).toBe(false)
  })

  test('sets permanent false for a 429', () => {
    const rateLimited = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1000000,
      refreshToken: 't',
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
      refreshToken: 't',
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
      refreshToken: 't',
    })
    expect(dead.permanent).toBe(true)
    expect(isPermanentRefreshError(dead)).toBe(true)
  })
})

describe('isPermanentRefreshError', () => {
  test('400 (invalid_grant) → permanent (dead token, needs re-login)', () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: 1000000,
      refreshToken: 't',
    })
    expect(isPermanentRefreshError(error)).toBe(true)
  })

  test('429 (rate limited) → NOT permanent (transient, recovers)', () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1000000,
      refreshToken: 't',
    })
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('500 (server error) → NOT permanent (transient)', () => {
    const error = buildRefreshOperationError({
      error: { status: 500 },
      now: 1000000,
      refreshToken: 't',
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
      refreshToken: 't',
    })
    // Sanity: it really did get the 24h non-transient delay (so the legacy
    // heuristic alone would have wrongly flagged it permanent).
    expect(error.nextRetryAt).toBe(1000000 + 24 * 60 * 60_000)
    expect(isPermanentRefreshError(error)).toBe(false)
  })
})

describe('isPermanentRefreshError across save/load round-trip', () => {
  test('retry-exhausted transient survives round-trip as NON-permanent', async () => {
    // The classification only matters once persisted. A retry-exhausted error
    // is permanent=false in memory but gets a 24h NON_TRANSIENT backoff — if the
    // status/permanent fields are dropped on load, the 24h-delay heuristic wrongly
    // re-classifies it permanent and the sidebar falsely nags re-login.
    const error = buildRefreshOperationError({
      error: new Error('Token refresh exhausted all retries'),
      now: Date.now(),
      refreshToken: 'rt-exhausted',
    })
    expect(error.permanent).toBe(false)
    expect(isPermanentRefreshError(error)).toBe(false)

    const storage = baseStorage()
    storage.accounts.push({
      id: 'exhausted',
      type: 'oauth',
      refresh: 'rt-exhausted',
      lastRefreshError: error,
    })
    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    const reloaded = expectOAuthAccount(
      loaded!.accounts.find((a) => a.id === 'exhausted'),
    )
    expect(reloaded.lastRefreshError?.permanent).toBe(false)
    expect(isPermanentRefreshError(reloaded.lastRefreshError)).toBe(false)
  })

  test('400 invalid_grant survives round-trip as permanent', async () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: Date.now(),
      refreshToken: 'rt-dead',
    })
    expect(error.permanent).toBe(true)

    const storage = baseStorage()
    storage.accounts.push({
      id: 'dead',
      type: 'oauth',
      refresh: 'rt-dead',
      lastRefreshError: error,
    })
    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    const reloaded = expectOAuthAccount(
      loaded!.accounts.find((a) => a.id === 'dead'),
    )
    expect(reloaded.lastRefreshError?.status).toBe(400)
    expect(reloaded.lastRefreshError?.permanent).toBe(true)
    expect(isPermanentRefreshError(reloaded.lastRefreshError)).toBe(true)
  })

  test('400 non-invalid_grant survives round-trip as NON-permanent', async () => {
    // A 400 invalid_client (misconfig) must NOT nag re-login — and the explicit
    // permanent=false must survive load so the status===400 fallback never fires.
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, '{"error":"invalid_client"}'),
      now: Date.now(),
      refreshToken: 'rt-misconfig',
    })
    expect(error.permanent).toBe(false)

    const storage = baseStorage()
    storage.accounts.push({
      id: 'misconfig',
      type: 'oauth',
      refresh: 'rt-misconfig',
      lastRefreshError: error,
    })
    await saveAccounts(storage, accountPath)

    const loaded = await loadAccounts(accountPath)
    const reloaded = expectOAuthAccount(
      loaded!.accounts.find((a) => a.id === 'misconfig'),
    )
    expect(reloaded.lastRefreshError?.status).toBe(400)
    expect(reloaded.lastRefreshError?.permanent).toBe(false)
    expect(isPermanentRefreshError(reloaded.lastRefreshError)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Duck-typed ProviderHttpError contract — isTransientRefreshError
// (tested through buildRefreshOperationError)
// ---------------------------------------------------------------------------
describe('isTransientRefreshError via duck-typed error classification', () => {
  const now = 1_000_000
  const REFRESH_NON_TRANSIENT = 24 * 60 * 60_000

  test('429 (duck-typed .status) → transient', () => {
    const result = buildRefreshOperationError({
      error: { status: 429 },
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt!).toBeLessThan(now + REFRESH_NON_TRANSIENT)
  })

  test('500 (duck-typed .status) → transient', () => {
    const result = buildRefreshOperationError({
      error: { status: 500 },
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt!).toBeLessThan(now + REFRESH_NON_TRANSIENT)
  })

  test('503 (duck-typed .status) → transient', () => {
    const result = buildRefreshOperationError({
      error: { status: 503 },
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt!).toBeLessThan(now + REFRESH_NON_TRANSIENT)
  })

  test('401 (duck-typed .status) → NOT transient', () => {
    const result = buildRefreshOperationError({
      error: { status: 401 },
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt).toBe(now + REFRESH_NON_TRANSIENT)
  })

  test('400 (duck-typed .status) → NOT transient', () => {
    const result = buildRefreshOperationError({
      error: { status: 400 },
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt).toBe(now + REFRESH_NON_TRANSIENT)
  })

  test('plain Error with fetch failed → transient (network path)', () => {
    const result = buildRefreshOperationError({
      error: new Error('fetch failed'),
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt!).toBeLessThan(now + REFRESH_NON_TRANSIENT)
  })

  test('ClaudeOAuthRefreshError 429 still classified transient (regression)', () => {
    const result = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt!).toBeLessThan(now + REFRESH_NON_TRANSIENT)
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
      refreshToken: 't',
    })
    expect(result.nextRetryAt).toBe(now + 60_000)
  })

  test('ClaudeOAuthRefreshError retryAfter still works (regression)', () => {
    const result = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited', '120'),
      now,
      refreshToken: 't',
    })
    expect(result.nextRetryAt).toBe(now + 120_000)
  })
})

// ---------------------------------------------------------------------------
// Duck-typed ProviderHttpError contract — isTransientQuotaError
// (tested through buildQuotaOperationError)
// ---------------------------------------------------------------------------
describe('isTransientQuotaError via duck-typed error classification', () => {
  const now = 1_000_000
  const QUOTA_NON_TRANSIENT = 5 * 60_000

  test('429 (duck-typed .status) → transient', () => {
    const result = buildQuotaOperationError({
      error: { status: 429 },
      now,
    })
    expect(result.nextRetryAt!).toBeLessThan(now + QUOTA_NON_TRANSIENT)
  })

  test('500 (duck-typed .status) → transient', () => {
    const result = buildQuotaOperationError({
      error: { status: 500 },
      now,
    })
    expect(result.nextRetryAt!).toBeLessThan(now + QUOTA_NON_TRANSIENT)
  })

  test('401 (duck-typed .status) → NOT transient', () => {
    const result = buildQuotaOperationError({
      error: { status: 401 },
      now,
    })
    expect(result.nextRetryAt).toBe(now + QUOTA_NON_TRANSIENT)
  })

  test('400 (duck-typed .status) → NOT transient', () => {
    const result = buildQuotaOperationError({
      error: { status: 400 },
      now,
    })
    expect(result.nextRetryAt).toBe(now + QUOTA_NON_TRANSIENT)
  })

  test('plain Error with fetch failed → transient (network path)', () => {
    const result = buildQuotaOperationError({
      error: new Error('fetch failed'),
      now,
    })
    expect(result.nextRetryAt!).toBeLessThan(now + QUOTA_NON_TRANSIENT)
  })

  test('duck-typed { status: 429 } — proves no regex/instanceof dependency', () => {
    // A plain object (not Error, not ClaudeOAuthRefreshError) with just .status
    const result = buildQuotaOperationError({
      error: { status: 429 },
      now,
    })
    expect(result.nextRetryAt!).toBeLessThan(now + QUOTA_NON_TRANSIENT)
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
    expect(quotaSnapshotModelScopeIsExhausted(quota, 'claude-fable-5')).toBe(
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

// ---------------------------------------------------------------------------
// recordQuotaRefreshError — refresh-backoff arming via isRefreshError
// (tested through FallbackAccountManager integration path)
// ---------------------------------------------------------------------------
describe('recordQuotaRefreshError refresh-backoff arming', () => {
  test('non-401 refresh error (status 500) arms refresh backoff', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fb-500-refresh',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1, // way in the past → tokenNeedsRefresh
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: string | URL | Request) => {
      return Promise.resolve(new Response('server error', { status: 500 }))
    }) as unknown as typeof fetch

    const now = 1_000_000
    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => now,
    })

    await manager.refreshQuotaForDueAccounts()

    const loaded = await loadAccounts()
    const account = loaded?.accounts.find((a) => a.id === 'fb-500-refresh') as
      | OAuthAccount
      | undefined
    expect(account?.lastRefreshError).toBeDefined()
    expect(account?.lastRefreshError?.checkedAt).toBe(now)
  })

  test('401 refresh error arms refresh backoff (ClaudeOAuthRefreshError regression)', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fb-401-refresh',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1,
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: string | URL | Request) => {
      return Promise.resolve(new Response('unauthorized', { status: 401 }))
    }) as unknown as typeof fetch

    const now = 1_000_000
    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => now,
    })

    await manager.refreshQuotaForDueAccounts()

    const loaded = await loadAccounts()
    const account = loaded?.accounts.find((a) => a.id === 'fb-401-refresh') as
      | OAuthAccount
      | undefined
    expect(account?.lastRefreshError).toBeDefined()
    expect(account?.lastRefreshError?.checkedAt).toBe(now)
  })

  test('quota-endpoint 401 does NOT arm refresh backoff (isRefreshError boundary)', async () => {
    const now = 1_000_000
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fb-quota-401',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      // Token is fresh → tokenNeedsRefresh returns false, skipping
      // the initial refresh step. This ensures the only error is from
      // the quota endpoint, not from a token refresh.
      expires: now + 24 * 60 * 60_000,
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input.href
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      // Quota endpoint returns 401
      return Promise.resolve(
        new Response('quota unauthorized', { status: 401 }),
      )
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => now,
    })

    await manager.refreshQuotaForDueAccounts()

    const loaded = await loadAccounts()
    const account = loaded?.accounts.find((a) => a.id === 'fb-quota-401') as
      | OAuthAccount
      | undefined
    // Quota-401 must NOT arm the refresh backoff — only isRefreshError does.
    expect(account?.lastRefreshError).toBeUndefined()
    // Quota-401 DOES arm the quota backoff.
    expect(account?.lastQuotaRefreshError).toBeDefined()
    expect(account?.lastQuotaRefreshError?.checkedAt).toBe(now)
  })

  test('quota-endpoint 403 does NOT arm quota or refresh backoff', async () => {
    const now = 1_000_000
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fb-quota-403',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      // Token is fresh → tokenNeedsRefresh returns false, so the only failure
      // in this test comes from the quota endpoint, not token refresh.
      expires: now + 24 * 60 * 60_000,
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : input.href
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'permission_error',
              message:
                'OAuth authentication is currently not allowed for this organization.',
            },
          }),
          { status: 403 },
        ),
      )
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => now,
    })

    await manager.refreshQuotaForDueAccounts()

    const loaded = await loadAccounts()
    const account = loaded?.accounts.find((a) => a.id === 'fb-quota-403') as
      | OAuthAccount
      | undefined
    expect(account?.lastRefreshError).toBeUndefined()
    expect(account?.lastQuotaRefreshError).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Fix #2: writeJsonAtomic removes orphaned temp file on rename failure
// ---------------------------------------------------------------------------
describe('writeJsonAtomic temp cleanup', () => {
  test('removes temp file on rename failure', async () => {
    const renameMock = mock(async () => {
      throw new Error('forced rename failure')
    })
    mock.module('node:fs/promises', () => {
      const actual = require('node:fs/promises')
      return { ...actual, rename: renameMock }
    })

    try {
      const storage = baseStorage()
      const err = await saveAccounts(storage, accountPath).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('forced rename failure')

      const files = await readdir(tempDir)
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'))
      expect(tmpFiles).toEqual([])
    } finally {
      // Restore original module — Bun mock.restore() does not undo mock.module
      mock.module('node:fs/promises', () => require('node:fs/promises'))
    }
  })
})

// ---------------------------------------------------------------------------
// Fix #3: readJsonIfPresent throws on corrupt store instead of swallowing
// ---------------------------------------------------------------------------
describe('readJsonIfPresent corrupt-store handling', () => {
  test('throws a clear error on malformed JSON', async () => {
    await writeFile(accountPath, '{broken json', 'utf8')
    const err = await loadAccounts(accountPath).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('corrupt or unreadable')
    expect((err as Error).message).toContain(accountPath)
  })

  test('throws on unreadable file (EACCES-like, not ENOENT)', async () => {
    // Save valid accounts first so both config and state files exist
    const validStorage = baseStorage()
    await saveAccounts(validStorage, accountPath)
    // Replace the state file with a directory — readFile on a directory
    // returns EISDIR, which is not ENOENT, so readJsonIfPresent must throw
    const statePath = getAccountStatePath(accountPath)
    await rm(statePath)
    await mkdir(statePath)
    const err = await loadAccounts(accountPath).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('corrupt or unreadable')
  })

  test('returns not-present for genuinely missing file (ENOENT)', async () => {
    // accountPath doesn't exist yet
    const result = await loadAccounts(accountPath)
    expect(result).toBeNull()
  })

  test('loads valid JSON normally', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'test-account',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
    })
    await saveAccounts(storage, accountPath)
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts[0]?.id).toBe('test-account')
  })
})

// ---------------------------------------------------------------------------
// Fix #10: NaN quota utilization → unknown (fail-closed) instead of 0%→bypass
// ---------------------------------------------------------------------------
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
    // Pre-fix: NaN < 5 → false, NaN < 10 → false, so passes (returns true — bypass)
    // Post-fix: the guard in mapUsageWindow prevents NaN from entering the system;
    // but if NaN somehow arrives, killswitchPassesPolicy blocks because
    // failClosedOnUnknownQuota defaults to true and the bogus data indicates
    // an unknown/corrupt state. We test that NaN values in remainingPercent
    // cause the policy to block.
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
    // Save and reload so the threshold flows through normalizeKillswitchThresholds
    await saveAccounts(storage, accountPath)
    const loaded = await loadAccounts(accountPath)
    // The NaN should be normalized away — loadAccounts normalizes, so the
    // loaded storage should have the default thresholds
    // Test that killswitch works with default thresholds (not NaN)
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
    await saveAccounts(storage, accountPath)
    const loaded = await loadAccounts(accountPath)
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

  test('mapUsageWindow returns undefined for NaN utilization', () => {
    // mapUsageWindow is internal, but we test the observable behaviour:
    // a quota snapshot fetched with NaN utilization would produce an
    // undefined window, which killswitchPassesPolicy treats as unknown
    // (fail-closed blocking when failClosedOnUnknownQuota is true).
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    // Simulate the result of mapUsageWindow returning undefined for both windows
    const quota: OAuthQuotaSnapshot = {
      five_hour: undefined,
      seven_day: undefined,
    }
    // Both windows unknown → failClosedOnUnknownQuota=true → blocked
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)

    // When failClosedOnUnknownQuota=false, unknown windows pass
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fix #9: saveAccountState lost-update race — concurrent saves with different
// section flags must not overwrite each other's sections.
// ---------------------------------------------------------------------------
describe('saveAccountState lost-update race (#9)', () => {
  test('concurrent saves with different scopes persist both sections', async () => {
    const storage = baseStorage()
    storage.quota = {
      ...storage.quota,
      mainQuota: {
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: 100 },
      },
      mainQuotaCheckedAt: 100,
      mainQuotaToken: 'token-initial',
    }
    storage.refresh = {
      ...storage.refresh,
      mainLastRefreshError: {
        message: 'initial error',
        checkedAt: 100,
      },
      mainRefreshLeaseId: 'lease-initial',
    }
    await saveAccounts(storage)

    const ROUNDS = 50
    const failures: number[] = []

    for (let round = 0; round < ROUNDS; round++) {
      const quotaStorage = baseStorage()
      quotaStorage.quota = {
        ...quotaStorage.quota,
        mainQuota: {
          five_hour: {
            usedPercent: 20 + round,
            remainingPercent: 80 - round,
            checkedAt: 200 + round,
          },
        },
        mainQuotaCheckedAt: 200 + round,
        mainQuotaToken: `token-quota-${round}`,
      }

      const refreshStorage = baseStorage()
      refreshStorage.refresh = {
        ...refreshStorage.refresh,
        mainLastRefreshError: {
          message: `refresh error ${round}`,
          checkedAt: 300 + round,
        },
        mainRefreshLeaseId: `lease-${round}`,
        mainRefreshLeaseUntil: 400 + round,
      }

      await Promise.all([
        saveAccountState(quotaStorage, accountPath, { mainQuota: true }),
        saveAccountState(refreshStorage, accountPath, { mainRefresh: true }),
      ])

      const loaded = await loadAccounts()
      const quotaOk = loaded?.quota?.mainQuotaToken === `token-quota-${round}`
      const refreshOk = loaded?.refresh?.mainRefreshLeaseId === `lease-${round}`

      if (!quotaOk || !refreshOk) {
        failures.push(round)
        // Don't break — collect all failures for diagnostics
      }
    }

    if (failures.length) {
      const loaded = await loadAccounts()
      // Load state file directly for diagnostic detail
      const statePath = getAccountStatePath(accountPath)
      const stateRaw = await readFile(statePath, 'utf8').catch(() => 'MISSING')
      throw new Error(
        `Lost update in ${failures.length}/${ROUNDS} rounds (rounds: ${failures.slice(0, 10).join(', ')}). ` +
          `Last loaded mainQuotaToken=${loaded?.quota?.mainQuotaToken}, ` +
          `mainRefreshLeaseId=${loaded?.refresh?.mainRefreshLeaseId}. ` +
          `State file: ${stateRaw.slice(0, 300)}`,
      )
    }

    // Final verification: both sections have the last round's values
    const final = await loadAccounts()
    expect(final?.quota?.mainQuotaToken).toBe(`token-quota-${ROUNDS - 1}`)
    expect(final?.quota?.mainQuotaCheckedAt).toBe(200 + ROUNDS - 1)
    expect(final?.refresh?.mainRefreshLeaseId).toBe(`lease-${ROUNDS - 1}`)
    expect(final?.refresh?.mainRefreshLeaseUntil).toBe(400 + ROUNDS - 1)
  })
})

// -- Account-mutation helpers --------------------------------------------------

describe('upsertAccount', () => {
  test('inserts a new account when no id or label match exists', () => {
    const storage = baseStorage()
    const account: OAuthAccount = {
      id: 'new-id',
      type: 'oauth',
      refresh: 'refresh-token',
      label: 'new-label',
    }
    upsertAccount(storage, account)
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]!.id).toBe('new-id')
  })

  test('updates by id match, preserving addedAt', () => {
    const storage = baseStorage()
    const original: OAuthAccount = {
      id: 'existing',
      type: 'oauth',
      refresh: 'original-refresh',
      access: 'original-access',
      addedAt: 100,
    }
    storage.accounts.push(original)
    upsertAccount(storage, {
      id: 'existing',
      type: 'oauth',
      refresh: 'new-refresh',
      access: 'new-access',
    })
    expect(storage.accounts).toHaveLength(1)
    const updated = storage.accounts[0] as OAuthAccount
    expect(updated.access).toBe('new-access')
    expect(updated.refresh).toBe('new-refresh')
    expect(updated.addedAt).toBe(100)
  })

  test('updates by label match', () => {
    const storage = baseStorage()
    const original: OAuthAccount = {
      id: 'id-a',
      type: 'oauth',
      refresh: 'refresh-a',
      label: 'shared-label',
    }
    storage.accounts.push(original)
    upsertAccount(storage, {
      id: 'id-b',
      type: 'oauth',
      refresh: 'refresh-b',
      label: 'shared-label',
    })
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]!.id).toBe('id-b') // overwritten by incoming account
    expect((storage.accounts[0] as OAuthAccount).refresh).toBe('refresh-b') // updated
  })

  test('merges oauth-specific fields on update', () => {
    const storage = baseStorage()
    const original: OAuthAccount = {
      id: 'oauth-1',
      type: 'oauth',
      refresh: 'r1',
      quota: {
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: 1 },
      },
      lastRefreshedAt: 50,
      lastRefreshError: { message: 'old', checkedAt: 10 },
      lastQuotaRefreshError: { message: 'old-quota', checkedAt: 10 },
    }
    storage.accounts.push(original)
    upsertAccount(storage, {
      id: 'oauth-1',
      type: 'oauth',
      refresh: 'r2',
      quota: {
        five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: 2 },
      },
      lastRefreshedAt: 60,
      lastRefreshError: { message: 'new', checkedAt: 20 },
      lastQuotaRefreshError: { message: 'new-quota', checkedAt: 20 },
    })
    const merged = storage.accounts[0] as OAuthAccount
    expect(merged.quota).toBeDefined()
    expect(merged.lastRefreshedAt).toBe(60)
    expect(merged.lastRefreshError?.message).toBe('new')
    expect(merged.lastQuotaRefreshError?.message).toBe('new-quota')
  })
})

describe('removeAccount', () => {
  test('removes an existing account by id and returns true', () => {
    const storage = baseStorage()
    storage.accounts.push({ id: 'a', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'b', type: 'oauth', refresh: 'r' })
    expect(removeAccount(storage, 'a')).toBe(true)
    expect(storage.accounts.map((c) => c.id)).toEqual(['b'])
  })

  test('returns false when id not found', () => {
    const storage = baseStorage()
    expect(removeAccount(storage, 'nonexistent')).toBe(false)
  })
})

describe('reorderAccounts', () => {
  test('reorders to match orderedIds', () => {
    const storage = baseStorage()
    storage.accounts.push({ id: 'c', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'a', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'b', type: 'oauth', refresh: 'r' })
    reorderAccounts(storage, ['b', 'a', 'c'])
    expect(storage.accounts.map((c) => c.id)).toEqual(['b', 'a', 'c'])
  })

  test('unknown ids keep relative order at the end', () => {
    const storage = baseStorage()
    storage.accounts.push({ id: 'a', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'b', type: 'oauth', refresh: 'r' })
    reorderAccounts(storage, ['x']) // x unknown
    expect(storage.accounts.map((c) => c.id)).toEqual(['a', 'b'])
  })

  test('partial list puts known first, unknowns after preserving order', () => {
    const storage = baseStorage()
    storage.accounts.push({ id: 'c', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'a', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'b', type: 'oauth', refresh: 'r' })
    reorderAccounts(storage, ['a']) // only 'a' specified
    expect(storage.accounts.map((c) => c.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('setAccountEnabled', () => {
  test('sets enabled flag on matching account', () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'a',
      type: 'oauth',
      refresh: 'r',
      enabled: true,
    })
    storage.accounts.push({
      id: 'b',
      type: 'oauth',
      refresh: 'r',
      enabled: true,
    })
    expect(setAccountEnabled(storage, 'a', false)).toBe(true)
    expect(storage.accounts[0]!.enabled).toBe(false)
    expect(storage.accounts[1]!.enabled).toBe(true)
  })

  test('returns false when id not found', () => {
    const storage = baseStorage()
    expect(setAccountEnabled(storage, 'nonexistent', false)).toBe(false)
  })
})

// -- Persistent round-trip tests -----------------------------------------------

describe('multi-account persistence', () => {
  test('a stale full snapshot cannot delete a newer account from config or state', async () => {
    const current = baseStorage()
    current.accounts.push({
      id: 'umut',
      label: 'umut',
      type: 'oauth',
      access: 'umut-access',
      refresh: 'umut-refresh',
    })
    await saveAccounts(current, accountPath)

    const stale = baseStorage()
    stale.accounts.push({
      id: 'yiyi',
      label: 'yiyi',
      type: 'oauth',
      access: 'yiyi-access',
      refresh: 'yiyi-refresh',
    })
    await saveAccounts(stale, accountPath)

    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts.map((account) => account.id)).toEqual([
      'umut',
      'yiyi',
    ])
    expect(
      expectOAuthAccount(
        loaded?.accounts.find((account) => account.id === 'umut'),
      ).refresh,
    ).toBe('umut-refresh')
    expect(
      expectOAuthAccount(
        loaded?.accounts.find((account) => account.id === 'yiyi'),
      ).refresh,
    ).toBe('yiyi-refresh')

    const state = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(Object.keys(state.accounts)).toEqual(['umut', 'yiyi'])
  })

  test('concurrent account additions preserve both accounts', async () => {
    await Promise.all([
      addAccountPersistent(
        {
          id: 'first',
          label: 'first',
          type: 'oauth',
          refresh: 'first-refresh',
        },
        accountPath,
      ),
      addAccountPersistent(
        {
          id: 'second',
          label: 'second',
          type: 'oauth',
          refresh: 'second-refresh',
        },
        accountPath,
      ),
    ])

    const loaded = await loadAccounts(accountPath)
    expect(new Set(loaded?.accounts.map((account) => account.id))).toEqual(
      new Set(['first', 'second']),
    )
  })
})

describe('removeAccountPersistent', () => {
  test('persists removal across load', async () => {
    const storage = baseStorage()
    storage.accounts.push({ id: 'a', type: 'oauth', refresh: 'r' })
    await saveAccounts(storage)
    expect(await removeAccountPersistent('a', accountPath)).toBe(true)
    const loaded = await loadAccounts()
    expect(loaded?.accounts).toHaveLength(0)
  })

  test('returns false for unknown id', async () => {
    const storage = baseStorage()
    await saveAccounts(storage)
    expect(await removeAccountPersistent('nonexistent', accountPath)).toBe(
      false,
    )
  })

  test('prunes the orphaned per-account state on removal (full-save path)', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'doomed',
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
      lastRefreshError: {
        message: 'boom',
        checkedAt: Date.now(),
      },
    })
    await saveAccounts(storage, accountPath)

    // Sanity: the state file holds the per-account block before removal.
    const statePath = getAccountStatePath(accountPath)
    const before = JSON.parse(await readFile(statePath, 'utf8'))
    expect(before.accounts?.doomed).toBeDefined()

    expect(await removeAccountPersistent('doomed', accountPath)).toBe(true)

    const after = JSON.parse(await readFile(statePath, 'utf8'))
    expect(after.accounts?.doomed).toBeUndefined()
  })

  test('removing one fallback leaves the other fallback state intact', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'keep',
      type: 'oauth',
      access: 'keep-access',
      refresh: 'keep-refresh',
      expires: Date.now() + 3600_000,
    })
    storage.accounts.push({
      id: 'drop',
      type: 'oauth',
      access: 'drop-access',
      refresh: 'drop-refresh',
      expires: Date.now() + 3600_000,
    })
    await saveAccounts(storage, accountPath)

    expect(await removeAccountPersistent('drop', accountPath)).toBe(true)

    const statePath = getAccountStatePath(accountPath)
    const after = JSON.parse(await readFile(statePath, 'utf8'))
    expect(after.accounts?.drop).toBeUndefined()
    expect(after.accounts?.keep).toBeDefined()
    expect(after.accounts?.keep?.refresh).toBe('keep-refresh')
  })
})

describe('reorderAccountsPersistent', () => {
  test('persists reorder across load', async () => {
    const storage = baseStorage()
    storage.accounts.push({ id: 'c', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'a', type: 'oauth', refresh: 'r' })
    storage.accounts.push({ id: 'b', type: 'oauth', refresh: 'r' })
    await saveAccounts(storage)
    await reorderAccountsPersistent(['b', 'a', 'c'], accountPath)
    const loaded = await loadAccounts()
    expect(loaded?.accounts.map((c) => c.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('setAccountEnabledPersistent', () => {
  test('persists enabled flag across load', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'a',
      type: 'oauth',
      refresh: 'r',
      enabled: true,
    })
    await saveAccounts(storage)
    expect(await setAccountEnabledPersistent('a', false, accountPath)).toBe(
      true,
    )
    const loaded = await loadAccounts()
    expect(loaded?.accounts[0]?.enabled).toBe(false)
  })
})

describe('addAccountPersistent', () => {
  test('adds a new account and persists', async () => {
    const storage = baseStorage()
    await saveAccounts(storage)
    await addAccountPersistent(
      { id: 'new-acc', type: 'oauth', refresh: 'r' },
      accountPath,
    )
    const loaded = await loadAccounts()
    expect(loaded?.accounts).toHaveLength(1)
    expect(loaded?.accounts[0]?.id).toBe('new-acc')
  })
})

// -- setLogLevelPersistent -----------------------------------------------------

describe('setLogLevelPersistent', () => {
  test('persists storage.logging.level and sets runtime log level', async () => {
    const originalLevel = getLogLevel()
    try {
      const storage = baseStorage()
      await saveAccounts(storage)
      await setLogLevelPersistent('debug', accountPath)
      const loaded = await loadAccounts()
      expect(getPersistedLogLevel(loaded)).toBe('debug')
      expect(getLogLevel()).toBe('debug')
    } finally {
      setLogLevel(originalLevel)
    }
  })
})

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

  test('survives save/load round-trip', async () => {
    const _storage = baseStorage()
    await setPrimePersistentEnabled(true, accountPath)
    const loaded = await loadAccounts()
    expect(isPrimePersistentlyEnabled(loaded)).toBe(true)
  })
})

describe('setPrimePersistentEnabled', () => {
  test('writes only enabled to the config; runtime counters never enter the config', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
    })
    await saveAccounts(storage)
    await setPrimePersistentEnabled(true, accountPath)

    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.prime).toEqual({ enabled: true })
  })

  test('clears enabled when toggled off', async () => {
    await setPrimePersistentEnabled(true, accountPath)
    await setPrimePersistentEnabled(false, accountPath)
    const loaded = await loadAccounts()
    expect(isPrimePersistentlyEnabled(loaded)).toBe(false)
    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.prime).toEqual({ enabled: false })
  })
})

describe('incrementPrimeUsagePersistent', () => {
  test('initializes main counters on first success and accumulates tokens', async () => {
    const storage = baseStorage()
    await saveAccounts(storage)

    const counters = await incrementPrimeUsagePersistent(
      'main',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      1_721_111_111_000,
    )
    expect(counters).toEqual({
      count: 1,
      inputTokens: 20,
      outputTokens: 1,
      since: 1_721_111_111_000,
    })

    const next = await incrementPrimeUsagePersistent(
      'main',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      1_721_111_112_000,
    )
    expect(next).toEqual({
      count: 2,
      inputTokens: 40,
      outputTokens: 2,
      since: 1_721_111_111_000,
    })

    // Counters live in the runtime-state file, not the config file
    const rawConfig = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(rawConfig.prime).toBeUndefined()

    const rawState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(rawState.main.prime).toEqual({
      count: 2,
      inputTokens: 40,
      outputTokens: 2,
      since: 1_721_111_111_000,
    })
  })

  test('falls back to fallback account scoped counter', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
    })
    await saveAccounts(storage)

    const counters = await incrementPrimeUsagePersistent(
      'work-alt',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      1_721_111_112_000,
    )
    expect(counters).toEqual({
      count: 1,
      inputTokens: 20,
      outputTokens: 1,
      since: 1_721_111_112_000,
    })

    const rawState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(rawState.accounts['work-alt'].prime).toEqual({
      count: 1,
      inputTokens: 20,
      outputTokens: 1,
      since: 1_721_111_112_000,
    })
  })

  test('clamps missing or non-finite usage to zero', async () => {
    const storage = baseStorage()
    await saveAccounts(storage)

    const counters = await incrementPrimeUsagePersistent(
      'main',
      { inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY },
      accountPath,
      1,
    )
    expect(counters.count).toBe(1)
    expect(counters.inputTokens).toBe(0)
    expect(counters.outputTokens).toBe(0)
  })

  test('a scoped fallback increment preserves an unrelated account state', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      access: 'a',
    })
    storage.accounts.push({
      id: 'main-extra',
      type: 'oauth',
      refresh: 'r2',
      access: 'b',
    })
    await saveAccounts(storage)

    // Seed an unrelated runtime entry on the second account
    await saveAccountState(
      {
        ...storage,
        accounts: storage.accounts.map((acc) =>
          acc.id === 'main-extra'
            ? ({
                ...acc,
                access: 'pre-existing',
                lastRefreshedAt: 999,
              } as OAuthAccount)
            : acc,
        ),
      },
      accountPath,
      { accounts: ['main-extra'] },
    )

    await incrementPrimeUsagePersistent(
      'work-alt',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      1_721_111_112_000,
    )

    const loaded = await loadAccounts()
    const workAlt = loaded?.accounts.find((acc) => acc.id === 'work-alt') as
      | OAuthAccount
      | undefined
    const mainExtra = loaded?.accounts.find((acc) => acc.id === 'main-extra') as
      | OAuthAccount
      | undefined
    expect(workAlt?.prime?.count).toBe(1)
    expect(mainExtra?.access).toBe('pre-existing')
    expect(mainExtra?.lastRefreshedAt).toBe(999)
  })

  test('a main prime increment preserves fallback state', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      access: 'a',
    })
    await saveAccounts(storage)

    await incrementPrimeUsagePersistent(
      'work-alt',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      1,
    )

    await incrementPrimeUsagePersistent(
      'main',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      2,
    )

    const loaded = await loadAccounts()
    const workAlt = loaded?.accounts.find((acc) => acc.id === 'work-alt') as
      | OAuthAccount
      | undefined
    expect(workAlt?.prime?.count).toBe(1)
    expect(loaded?.prime?.main?.count).toBe(1)
  })

  test('malformed persisted prime counters are dropped on load', async () => {
    // Write a state file with invalid counter shapes directly. The
    // `normalizePrimeUsageCounters` validator must reject negative/NaN/
    // string-coerced fields, so loadAccounts returns `prime === undefined`
    // for the offending section — a regression that silently accepted
    // them would let the sidebar render NaN$ totals.
    const storage = baseStorage()
    storage.prime = {
      enabled: true,
      main: { count: -1, inputTokens: 0, outputTokens: 0, since: -5 },
    }
    await saveAccounts(storage)

    const loaded = await loadAccounts()
    expect(loaded?.prime?.enabled).toBe(true)
    expect(loaded?.prime?.main).toBeUndefined()

    // NaN / string-coerced fields are also rejected. Cast through unknown
    // so the test fixture can carry a malformed on-disk shape (the
    // normalizer is what we're testing, not the input type).
    const storage2 = baseStorage()
    storage2.prime = {
      enabled: true,
      main: {
        count: Number.NaN,
        inputTokens: 0,
        outputTokens: 0,
        since: 0,
      } as unknown as never,
    }
    await saveAccounts(storage2)
    const loaded2 = await loadAccounts()
    expect(loaded2?.prime?.main).toBeUndefined()

    // A fallback account with a malformed counter is dropped from the
    // account's prime field, but the rest of the account survives.
    const storage3 = baseStorage()
    storage3.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      access: 'a',
    })
    await saveAccounts(storage3)
    await incrementPrimeUsagePersistent(
      'work-alt',
      { inputTokens: 20, outputTokens: 1 },
      accountPath,
      1,
    )
    // Tamper the on-disk counter with a negative value.
    const statePath = getAccountStatePath(accountPath)
    const raw = JSON.parse(await readFile(statePath, 'utf8'))
    raw.accounts['work-alt'].prime.count = -7
    await writeFile(statePath, JSON.stringify(raw), 'utf8')
    const loaded3 = await loadAccounts()
    const workAlt3 = loaded3?.accounts.find((a) => a.id === 'work-alt') as
      | OAuthAccount
      | undefined
    expect(workAlt3?.prime).toBeUndefined()
    expect(workAlt3?.access).toBe('a')
  })
})

describe('getOrCreatePrimeAuthLineageId', () => {
  test('concurrent first lookups converge on one persisted fallback lineage', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'rotating-refresh',
    })
    await saveAccounts(storage)

    const [first, second] = await Promise.all([
      getOrCreatePrimeAuthLineageId('work-alt', accountPath),
      getOrCreatePrimeAuthLineageId('work-alt', accountPath),
    ])

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    const loaded = await loadAccounts(accountPath)
    expect(expectOAuthAccount(loaded?.accounts[0]).authLineageId).toBe(first)
  })

  test('concurrent main replacement observations converge on one new lineage', async () => {
    const original = await getOrCreatePrimeAuthLineageId(
      'main',
      accountPath,
      'main-refresh-a',
    )

    const [first, second] = await Promise.all([
      getOrCreatePrimeAuthLineageId('main', accountPath, 'main-refresh-b'),
      getOrCreatePrimeAuthLineageId('main', accountPath, 'main-refresh-b'),
    ])

    expect(first).toBe(second)
    expect(first).not.toBe(original)
    const rawState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(rawState.main.primeAuthLineageRefreshTokenFingerprint).toBe(
      tokenFingerprint('main-refresh-b'),
    )
  })

  test('a legacy main lineage binds once without changing identity', async () => {
    const legacy = 'legacy-main-lineage'
    await writeFile(
      getAccountStatePath(accountPath),
      `${JSON.stringify({
        version: 1,
        main: { primeAuthLineageId: legacy },
      })}\n`,
      'utf8',
    )

    const migrated = await getOrCreatePrimeAuthLineageId(
      'main',
      accountPath,
      'main-refresh-a',
    )

    expect(migrated).toBe(legacy)
    const rawState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(rawState.main.primeAuthLineageRefreshTokenFingerprint).toBe(
      tokenFingerprint('main-refresh-a'),
    )
  })

  test('a missing main refresh token does not mint or persist a lineage', async () => {
    const statePath = getAccountStatePath(accountPath)

    const first = await getOrCreatePrimeAuthLineageId('main', accountPath)
    const second = await getOrCreatePrimeAuthLineageId('main', accountPath)

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a missing main refresh token returns persisted lineage without writing', async () => {
    const statePath = getAccountStatePath(accountPath)
    const persisted = `${JSON.stringify({
      version: 1,
      main: { primeAuthLineageId: 'existing-main-lineage' },
    })}\n`
    await writeFile(statePath, persisted, 'utf8')

    const lineage = await getOrCreatePrimeAuthLineageId('main', accountPath)

    expect(lineage).toBe('existing-main-lineage')
    expect(await readFile(statePath, 'utf8')).toBe(persisted)
  })
})
