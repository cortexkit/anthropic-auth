import { describe, expect, mock } from 'bun:test'
import {
  type AccountStorage,
  hashRefreshToken,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { drainSidebarWrites, getSidebarState } from '../sidebar-state'
import { createMockClient } from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  poolMainIdentity as poolMainIdentityWithCtx,
  replacePoolMainLogin as replacePoolMainLoginWithCtx,
  syntheticMainHostAuth,
  updatePoolSettings as updatePoolSettingsWithCtx,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
  withNativeBootstrap as withNativeBootstrapWithCtx,
} from './support/opencode1-pool-fixture.ts'
import { expectUnknownQuotaAdmissionBlocked as expectUnknownQuotaAdmissionBlockedWithCtx } from './support/opencode1-quota-feed.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth: {
    access: string
    refresh: string
    expires: number
  } = syntheticMainHostAuth(),
) {
  return useTempAccountFileWithCtx(testContext, storage, mainHostAuth)
}
function poolMainIdentity(): string {
  return poolMainIdentityWithCtx(testContext)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function withNativeBootstrap<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeBootstrapWithCtx(testContext, handler)
}
function replacePoolMainLogin(
  credential: { access: string; refresh: string; expires: number },
  options?: { sameAccount: boolean; accountIdentity?: string },
) {
  return replacePoolMainLoginWithCtx(
    testContext,
    credential,
    options as { sameAccount: boolean; accountIdentity?: string },
  )
}
function updatePoolSettings(
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  return updatePoolSettingsWithCtx(testContext, mutator)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function expectUnknownQuotaAdmissionBlocked(storage: AccountStorage) {
  return expectUnknownQuotaAdmissionBlockedWithCtx(testContext, storage)
}

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
    let capturedUrl: string | undefined

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        capturedUrl = url
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(capturedUrl).toContain('beta=true')
  })

  test('fetch wrapper retries with a fallback account on configured status', async () => {
    await useTempAccountFile(createFallbackStorage())
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        const authHeader = init?.headers?.get('authorization')
        authorizations.push(authHeader)
        if (authHeader === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(new Response('limited', { status: 429 }))
        }
        return Promise.resolve(new Response('ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('fetch wrapper uses fallback first when routing mode is fallback-first', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ routing: { mode: 'fallback-first' } }),
      ),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          throw new Error('fallback-first should use cached quota in this test')
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('main-first tries an OAuth fallback whose quota is unknown after main fails', async () => {
    const expires = Date.now() + 5 * 60 * 60_000
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        return Promise.resolve(
          new Response(
            authorization === 'Bearer sk-ant-oat01-main-access'
              ? 'limited'
              : 'ok',
            {
              status:
                authorization === 'Bearer sk-ant-oat01-main-access' ? 429 : 200,
            },
          ),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-unknown-fallback-access',
    ])
  })

  test('fallback-first tries an OAuth fallback whose quota is unknown before main', async () => {
    const expires = Date.now() + 5 * 60 * 60_000
    // The account is known; only its quota is unknown.
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            ...createFallbackStorage().quota,
            failClosedOnUnknownQuota: false,
          },
          accounts: [
            {
              id: 'unknown-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-unknown-fallback-access',
              refresh: 'unknown-fallback-refresh',
              expires,
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-unknown-fallback-access',
    ])
  })

  test('fallback-first rejects an OAuth fallback whose quota is unknown under fail-closed', async () => {
    await expectUnknownQuotaAdmissionBlocked(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'unknown-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-unknown-fallback-access',
              refresh: 'unknown-fallback-refresh',
              expires: Date.now() + 5 * 60 * 60_000,
            },
          ],
        }),
      ),
    )
  })

  test('successful fallback-first request advances the every-N counter and refreshes the served fallback', async () => {
    // The request counter must increment before the fallback-first
    // early return, so a served fallback's active-route every-N refresh fires.
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          refreshEveryNRequests: 1,
          mainQuota: {
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: Date.now(),
            },
            seven_day: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: Date.now(),
            },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
        },
      }),
    )
    const usageTokens: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          usageTokens.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 20 },
                seven_day: { utilization: 20 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')

    // The active-route refresh is fire-and-forget; wait for it to land.
    for (
      let i = 0;
      i < 50 && !usageTokens.includes('Bearer sk-ant-oat01-fallback-access');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(usageTokens).toContain('Bearer sk-ant-oat01-fallback-access')
  })

  test('fallback-first routing does not refresh expired main oauth when fallback succeeds', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          refresh: { enabled: false },
        }),
      ),
      {
        access: 'sk-ant-oat01-expired-main-access',
        refresh: 'main-refresh',
        expires: Date.now() - 1000,
      },
    )
    let tokenRefreshCalls = 0
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1
          return Promise.resolve(
            new Response('should not refresh', { status: 500 }),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          throw new Error('fallback-first should use cached quota in this test')
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired-main-access',
          refresh: 'main-refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(tokenRefreshCalls).toBe(0)
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('fallback-first routing tries main when no fallback account is usable', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'fallback-low',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 95,
                  remainingPercent: 5,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('main ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('main ok')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('fetch wrapper skips main account when quota policy is already exhausted', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    const messageAuthorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 100 },
              }),
              { status: 200 },
            ),
          )
        }

        messageAuthorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('quota refresh toasts are disabled by default', async () => {
    const storage = createFallbackStorage({ accounts: [] })
    await useTempAccountFile(storage)
    const showToast = mock(() => Promise.resolve())
    const mockClient = {
      ...createMockClient(),
      tui: { showToast },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('main ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient as any)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(showToast).not.toHaveBeenCalled()
  })

  test('quota refresh toasts can be enabled explicitly', async () => {
    const storage = createFallbackStorage({ accounts: [] })
    storage.quota = { ...storage.quota, showToasts: true }
    await useTempAccountFile(storage)
    const showToast = mock(() => Promise.resolve())
    const mockClient = {
      ...createMockClient(),
      tui: { showToast },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('main ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient as any)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(showToast).toHaveBeenCalledWith({
      body: {
        title: 'Claude Quota',
        message: expect.stringContaining('main · active'),
        variant: 'info',
        duration: 5000,
      },
    })
  })

  test('fetch wrapper caches exhausted main quota until reset time', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    let quotaCalls = 0
    const messageAuthorizations: string[] = []
    const resetAt = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString()

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          quotaCalls += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 100, resets_at: resetAt },
              }),
              { status: 200 },
            ),
          )
        }

        messageAuthorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(new Response('fallback ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(quotaCalls).toBe(1)
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('fetch wrapper refreshes stale usable main quota in background', async () => {
    const originalDateNow = Date.now
    let now = originalDateNow()
    Date.now = mock(() => now) as unknown as typeof Date.now
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 1,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )

    let quotaCalls = 0
    let messageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          quotaCalls += 1
          if (quotaCalls > 1) return new Promise<Response>(() => {})
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        messageCalls += 1
        return Promise.resolve(
          new Response(`message-${messageCalls}`, { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: now + 1_000_000,
          }),
        { models: {} },
      )

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'message-1',
      )
      now += 120000
      // The second quota fetch never resolves. A correct background refresh
      // still lets the model response settle; a blocking implementation hits
      // this deadlock backstop regardless of machine speed.
      let timeout: ReturnType<typeof setTimeout> | undefined
      const second = await Promise.race([
        result
          .fetch(MESSAGES_URL, EMPTY_POST)
          .then((response: Response) => response.text()),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('model request blocked on quota refresh')),
            2_000,
          )
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout)
      })

      expect(second).toBe('message-2')
      // Background quota refresh involves file-lock I/O; poll until it fires
      // instead of sleeping a fixed interval (flaky under CI load). Date.now
      // is mocked here, so the deadline uses the real clock.
      const refreshDeadline = originalDateNow() + 5000
      while (quotaCalls < 2 && originalDateNow() < refreshDeadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(quotaCalls).toBe(2)
      expect(messageCalls).toBe(2)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('async main refresh does not clobber the active fallback in the sidebar', async () => {
    const staleCheckedAt = Date.now() - 100 * 60_000 // far past → main quota is stale
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            // The cached five-hour quota is stale, with 5% remaining below the 10% routing minimum.
            mainQuota: {
              five_hour: {
                usedPercent: 95,
                remainingPercent: 5,
                checkedAt: staleCheckedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt: staleCheckedAt,
              },
            },
            mainQuotaCheckedAt: staleCheckedAt,
            // Associate the cached main quota with the fingerprint of the loader's access token.
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
        }),
      ),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.95 },
                seven_day: { utilization: 0.1 },
              }),
              { status: 200 },
            ),
          )
        }
        // Anthropic messages call — fallback serves 200, main would not be reached.
        return Promise.resolve(new Response('ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    await drainSidebarWrites()

    // Fallback served → active id should be the fallback.
    const state = await waitForSidebarState(
      (candidate) =>
        candidate.activeId === 'fallback-1' && candidate.route === 'fallback',
    )
    expect(state.route).toBe('fallback')

    // The callback must preserve the active fallback instead of selecting main.
    const after = await getSidebarState()
    expect(after.activeId).toBe('fallback-1')
  })

  test('fetch wrapper retries with fallback when main streaming body reports rate limit', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        const authHeader = init?.headers?.get('authorization')
        authorizations.push(authHeader)
        if (authHeader === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(
            new Response(
              'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account rate limit"}}\n\n',
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(
          new Response('data: {"type":"message_stop"}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
  })

  test('fetch wrapper returns inspected streaming rate limit response when fallbacks are unavailable', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-low',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 95,
                  remainingPercent: 5,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        authorizations.push(init?.headers?.get('authorization'))
        return Promise.resolve(
          new Response(
            'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account rate limit"}}\n\n',
            { status: 200 },
          ),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('rate_limit_error')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('fetch wrapper does not use fallback accounts below quota thresholds', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-low',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 95,
                  remainingPercent: 5,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )
    let calls = 0

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        calls += 1
        return Promise.resolve(new Response('limited', { status: 429 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    expect(await response.text()).toBe('limited')
    expect(calls).toBe(1)
  })

  test('fetch wrapper avoids fallback retries for non-replayable request bodies', async () => {
    await useTempAccountFile(bindPoolAccounts(createFallbackStorage()))
    let calls = 0
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        controller.close()
      },
    })

    globalThis.fetch = mock(
      withNativeAdmission(() => {
        calls += 1
        return Promise.resolve(new Response('limited', { status: 429 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    })

    expect(response.status).toBe(429)
    expect(calls).toBe(1)
  })

  test('sticky-balanced assigns cold Fable to abundant quota and keeps Opus recovery on that account', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - fableRemaining,
        remainingPercent: Math.max(40, fableRemaining),
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(0),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'yiyi',
              type: 'oauth',
              access: 'sk-ant-oat01-scarce-access',
              refresh: 'scarce-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(13),
            },
            {
              id: 'ufuk2',
              type: 'oauth',
              access: 'sk-ant-oat01-abundant-access',
              refresh: 'abundant-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(98),
            },
          ],
        }),
      ),
    )
    const models: string[] = []
    const authorizations: string[] = []
    let refusal = true
    let rejectMain = false
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const successSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.max_tokens === 0) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        models.push(String(body.model))
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (rejectMain && authorization === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(new Response('forbidden', { status: 403 }))
        }
        if (refusal) {
          refusal = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-abundant-access',
      'Bearer sk-ant-oat01-abundant-access',
    ])

    const directOpus = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_direct_opus' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 128_000,
        stream: true,
        messages: [{ role: 'user', content: 'direct Opus' }],
      }),
    })
    await directOpus.text()
    expect(authorizations.at(-1)).toBe('Bearer sk-ant-oat01-main-access')

    rejectMain = true
    const migratedOpus = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_direct_opus_migration' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'migrate Opus' }],
      }),
    })
    await migratedOpus.text()
    expect(authorizations.slice(-2)).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-scarce-access',
    ])
  })

  test('sticky-balanced reselects after the user changes the session model', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(0),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'fable-rich',
              type: 'oauth',
              access: 'sk-ant-oat01-fable-rich-access',
              refresh: 'fable-rich-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(100),
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []
    const successSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response(successSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const request = (model: string) => ({
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_user_model_change' },
      body: JSON.stringify({
        model,
        max_tokens: 128_000,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    await (await result.fetch(MESSAGES_URL, request('claude-fable-5-1'))).text()
    await (await result.fetch(MESSAGES_URL, request('claude-opus-5'))).text()

    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-fable-rich-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  test('sticky-balanced reports main re-login instead of falling through when no fallback can serve the requested model', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          refresh: {
            enabled: true,
            intervalMinutes: 10,
            refreshBeforeExpiryMinutes: 240,
            mainLastRefreshError: {
              message:
                'Claude OAuth refresh failed: 400 — {"error":"invalid_grant"}',
              checkedAt,
              nextRetryAt: checkedAt + 24 * 60 * 60_000,
              retryCount: 1,
              tokenHash: hashRefreshToken('main-refresh'),
              status: 400,
              permanent: true,
            },
          },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(88),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'fallback-a',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-a-access',
              refresh: 'fallback-a-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(0),
            },
            {
              id: 'fallback-b',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-b-access',
              refresh: 'fallback-b-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(0),
            },
          ],
        }),
      ),
      {
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: checkedAt - 1,
      },
    )
    let messageRequests = 0
    let reLoginQuotaPolls = 0
    const servedAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            reLoginQuotaPolls += 1
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 12,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
            )
          }
          if (url.includes('/v1/messages')) {
            messageRequests += 1
            servedAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const currentAuth = {
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: checkedAt - 1,
    }
    const result = await plugin.auth.loader(
      () => Promise.resolve(currentAuth),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_no_fable_route' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message:
          'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for Fable.',
      },
    })
    expect(messageRequests).toBe(0)

    await replacePoolMainLogin({
      access: 'sk-ant-oat01-main-access',
      refresh: 'relogged-main-refresh',
      expires: checkedAt + 5 * 60 * 60_000,
    })
    const recovered = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_no_fable_route' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'after re-login' }],
      }),
    })

    expect(recovered.status).toBe(200)
    expect(messageRequests).toBe(1)
    expect(servedAuthorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
    expect(reLoginQuotaPolls).toBe(1)
    const saved = await readAccountStorage()
    expect(saved?.refresh?.mainLastRefreshError).toBeUndefined()
    expect(saved?.quota?.mainQuota?.scoped?.[0]?.remainingPercent).toBe(88)
    expect(saved?.quota?.mainQuota?.accountIdentity).toBe(poolMainIdentity())
  })

  test('sticky-balanced uses API routes only after confirmed OAuth exhaustion', async () => {
    const checkedAt = Date.now()
    const quota = (remainingPercent: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(0),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'oauth-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(100),
            },
            {
              id: 'api-fallback',
              type: 'api',
              baseURL: 'https://provider.example/anthropic',
              authHeader: 'authorization-bearer',
              apiKey: 'api-key',
            },
          ],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 100 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 100,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        return Promise.resolve(
          authorization === 'Bearer sk-ant-oat01-fallback-access'
            ? new Response('exhausted', { status: 429 })
            : new Response('ok', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_api' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer api-key',
    ])
  })

  test('sticky-balanced seeds an already-warm CacheKeep session from its current account', async () => {
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'main-first' },
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: true, always: true },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: quota(13),
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
          accounts: [
            {
              id: 'ufuk2',
              type: 'oauth',
              access: 'sk-ant-oat01-abundant-access',
              refresh: 'abundant-refresh',
              expires: checkedAt + 5 * 60 * 60_000,
              quota: quota(98),
            },
          ],
        }),
      ),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response('ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 100_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_warm_cutover' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        system: [{ type: 'text', text: 'stable' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    await (await result.fetch(MESSAGES_URL, request)).text()
    await updatePoolSettings((settings) => ({
      ...settings,
      routing: { mode: 'sticky-balanced' },
    }))
    await (await result.fetch(MESSAGES_URL, request)).text()

    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  for (const maxSameAccountWait of ['15', 'max'] as const) {
    for (const window of ['5h', '7d', 'model-scoped'] as const) {
      test(`sticky-balanced retains the assigned account across transient errors and a cache-bound ${window} reset with ${maxSameAccountWait} wait`, async () => {
        const checkedAt = Date.now()
        const holdMinutes =
          maxSameAccountWait === 'max' ? 30 : window === '5h' ? 14 : 10
        const shortResetAt = new Date(
          checkedAt + holdMinutes * 60_000,
        ).toISOString()
        const longResetAt = new Date(checkedAt + 2 * 60 * 60_000).toISOString()
        let useLongReset = false
        let now = checkedAt
        const quota = (fableRemaining: number) => ({
          checkedAt,
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(checkedAt + 5 * 60 * 60_000).toISOString(),
            checkedAt,
          },
          seven_day: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
            checkedAt,
          },
          scoped: [
            {
              id: 'claude-weekly-scoped-fable',
              title: 'Fable only',
              modelName: 'Fable',
              usedPercent: 100 - fableRemaining,
              remainingPercent: fableRemaining,
              resetsAt: new Date(
                checkedAt + 4 * 24 * 60 * 60_000,
              ).toISOString(),
              checkedAt,
            },
          ],
        })
        await useTempAccountFile(
          bindPoolAccounts(
            createFallbackStorage({
              routing: { mode: 'sticky-balanced', maxSameAccountWait },
              claudeCache: { enabled: true, mode: 'explicit' },
              quota: {
                enabled: true,
                checkIntervalMinutes: 5,
                minimumRemaining: { five_hour: 1, seven_day: 1 },
                failClosedOnUnknownQuota: true,
                mainQuota: quota(0),
                mainQuotaCheckedAt: checkedAt,
                mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
              },
              accounts: [
                {
                  id: 'yiyi',
                  type: 'oauth',
                  access: 'sk-ant-oat01-scarce-access',
                  refresh: 'scarce-refresh',
                  expires: checkedAt + 5 * 60 * 60_000,
                  quota: quota(13),
                },
                {
                  id: 'ufuk2',
                  type: 'oauth',
                  access: 'sk-ant-oat01-abundant-access',
                  refresh: 'abundant-refresh',
                  expires: checkedAt + 5 * 60 * 60_000,
                  quota: quota(98),
                },
              ],
            }),
          ),
        )
        const authorizations: string[] = []
        let modelRequest = 0
        globalThis.fetch = mock(
          withNativeAdmission((input: any, init: any) => {
            const url = extractUrl(input)
            if (url.includes('/api/oauth/usage')) {
              const authorization = new Headers(init?.headers).get(
                'authorization',
              )
              const abundant =
                authorization === 'Bearer sk-ant-oat01-abundant-access'
              const main = authorization === 'Bearer sk-ant-oat01-main-access'
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    five_hour: {
                      utilization: abundant && window === '5h' ? 100 : 0,
                      resets_at: useLongReset ? longResetAt : shortResetAt,
                    },
                    seven_day: {
                      utilization: abundant && window === '7d' ? 100 : 0,
                      resets_at: useLongReset ? longResetAt : shortResetAt,
                    },
                    limits: [
                      {
                        kind: 'weekly_scoped',
                        group: 'weekly',
                        percent:
                          main || (abundant && window === 'model-scoped')
                            ? 100
                            : abundant
                              ? 2
                              : 87,
                        resets_at:
                          abundant && window === 'model-scoped'
                            ? useLongReset
                              ? longResetAt
                              : shortResetAt
                            : new Date(
                                checkedAt + 4 * 24 * 60 * 60_000,
                              ).toISOString(),
                        scope: { model: { display_name: 'Fable' } },
                      },
                    ],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (!url.includes('/v1/messages')) {
              return Promise.resolve(new Response('{}', { status: 200 }))
            }
            authorizations.push(
              new Headers(init?.headers).get('authorization') ?? '',
            )
            modelRequest += 1
            if (modelRequest === 1) {
              return Promise.resolve(new Response('temporary', { status: 500 }))
            }
            if (modelRequest === 2) {
              return Promise.resolve(
                new Response(
                  'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}\n\n',
                  { status: 200 },
                ),
              )
            }
            return Promise.resolve(new Response('ok', { status: 200 }))
          }),
        ) as unknown as typeof fetch

        Date.now = mock(() => now) as unknown as typeof Date.now
        const plugin = await getPlugin()
        const result = await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: 'sk-ant-oat01-main-access',
              refresh: 'main-refresh',
              expires: checkedAt + 10 * 60 * 60_000,
            }),
          { models: {} },
        )
        const request = {
          method: 'POST',
          headers: { 'x-session-affinity': 'ses_sticky_hold' },
          body: JSON.stringify({
            model: 'claude-fable-5',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        }

        expect((await result.fetch(MESSAGES_URL, request)).status).toBe(500)
        const held = await result.fetch(MESSAGES_URL, request)
        expect(held.status).toBe(429)
        expect(Number(held.headers.get('retry-after'))).toBeGreaterThanOrEqual(
          holdMinutes * 60,
        )
        expect(Number(held.headers.get('retry-after'))).toBeLessThanOrEqual(
          holdMinutes * 60 + 20,
        )
        expect(await held.text()).toContain(
          'Sticky OAuth account quota resets shortly; retaining session affinity.',
        )
        const proactive = await result.fetch(MESSAGES_URL, request)
        expect(proactive.status).toBe(429)
        expect(await proactive.text()).toContain(
          'Sticky OAuth account quota resets shortly; retaining session affinity.',
        )
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-abundant-access',
          'Bearer sk-ant-oat01-abundant-access',
        ])

        useLongReset = true
        now += 6 * 60_000
        const migrated = await result.fetch(MESSAGES_URL, request)
        expect(migrated.status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-abundant-access',
          'Bearer sk-ant-oat01-abundant-access',
          'Bearer sk-ant-oat01-scarce-access',
        ])
      })
    }
  }
})
