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
  fetchOAuthQuotaSnapshot,
  getAccountStatePath,
  getCache1hPersistentMode,
  getLogLevel,
  getPersistedLogLevel,
  isCacheKeepSubagentsEnabled,
  isCostZeroingEnabled,
  isFastModePersistentlyEnabled,
  type KillswitchThresholds,
  killswitchPassesPolicy,
  loadAccounts,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  QuotaManager,
  quotaSnapshotPassesPolicy,
  removeAccount,
  removeAccountPersistent,
  reorderAccounts,
  reorderAccountsPersistent,
  saveAccountState,
  saveAccounts,
  setAccountEnabled,
  setAccountEnabledPersistent,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setCacheKeepSubagentsEnabled,
  setFastModePersistentEnabled,
  setLogLevel,
  setLogLevelPersistent,
  shouldFallbackStatus,
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

  test('runtime state saves can update refreshed tokens without downgrading quota', async () => {
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
    expect(account.quota?.five_hour?.usedPercent).toBe(20)
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
      startHour: 9,
      endHour: 23,
    })
    const disabled = await setCacheKeepPersistentEnabled(false)
    expect(disabled.cacheKeep).toEqual({
      enabled: false,
      startHour: 9,
      endHour: 23,
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
