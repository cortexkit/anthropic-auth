import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  acquireRefreshFileLock,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  FallbackAccountManager,
  getCache1hPersistentMode,
  isFastModePersistentlyEnabled,
  loadAccounts,
  QuotaManager,
  saveAccounts,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setFastModePersistentEnabled,
  shouldFallbackStatus,
} from '@cortexkit/anthropic-auth-core'

let tempDir: string
let accountPath: string

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

    const raw = await readFile(accountPath, 'utf8')
    expect(JSON.parse(raw).accounts[0].id).toBe('fallback-1')
    await expect(loadAccounts()).resolves.toEqual(storage)
  })

  test('malformed sidecar file is ignored', async () => {
    await writeFile(accountPath, '{nope', 'utf8')
    await expect(loadAccounts()).resolves.toBeNull()
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
    expect(saved?.accounts[0]?.refresh).toBe('new-refresh')
    expect(saved?.accounts[0]?.expires).toBe(3_601_000)
    expect(saved?.accounts[0]?.lastRefreshedAt).toBe(1_000)
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
    expect(saved?.accounts[0]?.refresh).toBe('new-refresh')
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
    expect(saved?.accounts[0]?.lastRefreshError?.nextRetryAt).toBeGreaterThan(
      2_000,
    )
    expect(saved?.accounts[0]?.lastRefreshError?.retryCount).toBe(1)
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
    expect(saved?.accounts[0]?.access).toBe('new-access')
    expect(saved?.accounts[0]?.refresh).toBe('old-refresh')
    expect(saved?.accounts[0]?.lastRefreshedAt).toBe(1_000)
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

    const refreshed = await manager.refreshAccount(stale.accounts[0]!, stale)

    expect(refreshed.access).toBe('fresh-access')
    expect(stale.accounts[0]?.refresh).toBe('fresh-refresh')
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
    expect(saved?.accounts[0]?.access).toBe('new-access')
    expect(saved?.accounts[0]?.refresh).toBe('new-refresh')
    expect(saved?.accounts[0]?.lastRefreshError).toBeUndefined()
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
    await new Promise((resolve) => setTimeout(resolve, 10))
    manager.stopBackgroundRefresh()

    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.access).toBe('fresh-access')
    expect(saved?.accounts[0]?.refresh).toBe('fresh-refresh')
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
    expect(saved?.accounts[0]?.access).toBe('new-access')
    expect(saved?.accounts[0]?.refresh).toBe('new-refresh')
    expect(saved?.accounts[0]?.lastRefreshedAt).toBe(1_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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
    expect(saved?.accounts[0]?.refresh).toBe('fresh-refresh')
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
    expect(saved?.accounts[0]?.quota?.five_hour?.remainingPercent).toBe(90)
    expect(saved?.accounts[0]?.lastQuotaRefreshError).toBeUndefined()
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
    expect(result.storage?.accounts[0]?.quota).toBeUndefined()
    expect(result.errors).toEqual([
      {
        accountId: 'invalid-refresh',
        message: 'Claude OAuth refresh failed: 400 — invalid_grant',
      },
    ])
    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.lastQuotaRefreshError?.message).toBe(
      'Claude OAuth refresh failed: 400 — invalid_grant',
    )
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
    expect(saved?.accounts[0]?.quota?.five_hour?.remainingPercent).toBe(30)
    expect(saved?.accounts[0]?.quota?.seven_day?.remainingPercent).toBe(70)
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
    qm.setFallback('fallback-1', {
      quota: {
        five_hour: { usedPercent: 100, remainingPercent: 0, checkedAt: 1_000 },
        seven_day: { usedPercent: 100, remainingPercent: 0, checkedAt: 1_000 },
      },
      refreshAfter: 1_000 + 10 * 60_000,
      checkedAt: 1_000,
    })

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
