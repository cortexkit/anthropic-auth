import { describe, expect, mock, spyOn } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  type AccountStorage,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  createNativePoolStore,
  custodyTombstoneOAuth,
  getAccountStatePath,
  hashRefreshToken,
  type ProviderAccountUuid,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  fireConcurrentFetches,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindMainAccount,
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  expectHostActivationNonSecret as expectHostActivationNonSecretWithCtx,
  getPlugin as getPluginWithCtx,
  mainAccountIssues as mainAccountIssuesWithCtx,
  nativeBootstrapAnswer as nativeBootstrapAnswerWithCtx,
  poolMainAccess as poolMainAccessWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  refreshPoolMainElsewhere as refreshPoolMainElsewhereWithCtx,
  replacePoolMainLogin as replacePoolMainLoginWithCtx,
  setupExpiredTokenLoader as setupExpiredTokenLoaderWithCtx,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  updatePoolSettings as updatePoolSettingsWithCtx,
  useTempAccountFile as useTempAccountFileWithCtx,
  waitForPoolCredential as waitForPoolCredentialWithCtx,
  withMainAdmission as withMainAdmissionWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
  withNativeBootstrap as withNativeBootstrapWithCtx,
} from './support/opencode1-pool-fixture.ts'
import { readAccountStorage as readAccountStorageWithCtx } from './support/opencode1-state-observers.ts'
import type {
  PluginRuntimeOverrides,
  PoolLogin,
} from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  getBodyLifetime,
  heldResponse as heldResponseWithCtx,
  installOpencode1TestHooks,
  lifetimeSignal as lifetimeSignalWithCtx,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL, TOKEN_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
}
function lifetimeSignal() {
  return lifetimeSignalWithCtx(testContext)
}
function heldResponse() {
  return heldResponseWithCtx(testContext)
}
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
function mainAccountIssues(...accesses: string[]) {
  return mainAccountIssuesWithCtx(testContext, ...accesses)
}
function nativeBootstrapAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins?: readonly PoolLogin[],
) {
  return nativeBootstrapAnswerWithCtx(testContext, input, init, logins)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function withMainAdmission<Input, Init>(
  handler: (input: Input, init: Init) => Response | Promise<Response>,
) {
  return withMainAdmissionWithCtx(testContext, handler)
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
function refreshPoolMainElsewhere(successor: {
  access: string
  refresh: string
  expires: number
}) {
  return refreshPoolMainElsewhereWithCtx(testContext, successor)
}
function waitForPoolCredential(routeId: string, access: string) {
  return waitForPoolCredentialWithCtx(testContext, routeId, access)
}
function updatePoolSettings(
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  return updatePoolSettingsWithCtx(testContext, mutator)
}
function expectHostActivationNonSecret(...tokens: string[]) {
  return expectHostActivationNonSecretWithCtx(testContext, ...tokens)
}
function poolMainAccess(): Promise<string> {
  return poolMainAccessWithCtx(testContext)
}
function readNativeRuntimeState() {
  return readNativeRuntimeStateWithCtx(testContext)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function setupExpiredTokenLoader(...issuedAccess: string[]) {
  return setupExpiredTokenLoaderWithCtx(testContext, ...issuedAccess)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}

async function runStickyDnsBackoffScenario(options: {
  tokenExpiresAt: number
  refreshErrorCheckedAt: number
  refreshErrorNextRetryAt: number
  refreshErrorRetryCount: number
}) {
  const now = Date.now()
  const cachedAt = now - 60 * 60_000
  const fableQuota = (remainingPercent: number, checkedAt: number) => ({
    checkedAt,
    five_hour: {
      usedPercent: 4,
      remainingPercent: 96,
      checkedAt,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
    },
    seven_day: {
      usedPercent: 18,
      remainingPercent: 82,
      checkedAt,
      resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
    },
    scoped: [
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
        resetsAt: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
      },
    ],
  })
  // Quota and refresh failures are tied to Claude account UUIDs, the only
  // identities migration carries into the native pool.
  const fallbackAccount = '00000000-0000-4000-8000-0000000d0e5f'
  await useTempAccountFile(
    bindMainQuotaToAccount(
      createFallbackStorage({
        routing: { mode: 'sticky-balanced' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: fableQuota(0, now),
          mainQuotaCheckedAt: now,
        },
        accounts: [
          {
            id: 'dns-backed-off',
            type: 'oauth',
            access: 'sk-ant-oat01-initial-fallback-access',
            refresh: 'fallback-refresh',
            expires: options.tokenExpiresAt,
            anthropicAccountUuid: fallbackAccount as ProviderAccountUuid,
            lastRefreshError: {
              message: 'getaddrinfo ENOTFOUND platform.claude.com',
              checkedAt: options.refreshErrorCheckedAt,
              nextRetryAt: options.refreshErrorNextRetryAt,
              retryCount: options.refreshErrorRetryCount,
              accountIdentity: fallbackAccount,
              permanent: false,
            },
            quota: {
              ...fableQuota(64, cachedAt),
              accountIdentity: fallbackAccount,
            },
          },
        ],
      }),
    ),
  )
  const pool = testContext.migratedPool
  if (!pool) throw new Error('DNS routing fixture did not migrate')
  const accountRuntime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const row = (await accountRuntime.read()).accounts.find(
      (account) => account.id === 'dns-backed-off',
    )
    expect(row?.binding?.identity).toBe(fallbackAccount)
    const stored = await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).read()
    const credential =
      stored.status === 'ready'
        ? stored.rows.find((entry) => entry.id === row?.binding?.rowId)
            ?.credential
        : undefined
    if (credential?.type !== 'oauth')
      throw new Error('DNS fixture has no bound OAuth credential')
    expect(credential.expires).toBe(options.tokenExpiresAt)
  } finally {
    accountRuntime.close()
  }
  const tokenRequests: string[] = []
  const messageAuthorizations: string[] = []
  globalThis.fetch = mock(
    withMainAdmission((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      if (url.includes('/v1/oauth/token')) {
        tokenRequests.push(url)
        return Promise.resolve(
          Response.json({
            access_token: 'sk-ant-oat01-refreshed-fallback-access',
            refresh_token: 'refreshed-fallback-refresh',
            expires_in: 8 * 60 * 60,
          }),
        )
      }
      if (url.includes('/api/oauth/usage')) {
        return Promise.resolve(
          Response.json({
            five_hour: {
              utilization: 4,
              resets_at: new Date(now + 60 * 60_000).toISOString(),
            },
            seven_day: {
              utilization: 18,
              resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
            },
            limits: [
              {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 36,
                resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
                scope: { model: { display_name: 'Fable' } },
              },
            ],
          }),
        )
      }
      if (url.includes('/claude_cli/bootstrap')) {
        return Promise.resolve(
          Response.json({ oauth_account: { account_uuid: fallbackAccount } }),
        )
      }
      if (url.includes('/v1/messages')) {
        messageAuthorizations.push(authorization)
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }),
  ) as unknown as typeof fetch

  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'sk-ant-oat01-main-access',
        refresh: 'main-refresh',
        expires: now + 8 * 60 * 60_000,
      }),
    { models: {} },
  )
  const response = await result.fetch(MESSAGES_URL, {
    method: 'POST',
    headers: { 'x-session-affinity': 'dns-backed-off-fable' },
    body: JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  return { response, tokenRequests, messageAuthorizations }
}

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('background refresh timers include per-process jitter', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
      }),
      {
        access: 'sk-ant-oat01-access',
        refresh: 'refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
    )
    Math.random = () => 0.5
    const intervalDelays: number[] = []
    const setIntervalMock = mock((handler: () => void, delay?: number) => {
      void handler
      intervalDelays.push(Number(delay))
      return { unref() {} }
    }) as unknown as typeof setInterval

    const plugin = await getPlugin(createMockClient(), undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-access',
          refresh: 'refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )

    expect(intervalDelays).toContain(90_000)
  })

  test('background refresh proactively rotates main oauth before expiry', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
        }),
        'sk-ant-oat01-old-access',
      ),
      {
        access: 'sk-ant-oat01-old-access',
        refresh: 'old-refresh',
        expires: Date.now() + 5 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval

    mainAccountIssues('sk-ant-oat01-background-access-new')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token'))
          return Response.json({
            refresh_token: 'background-refresh-new',
            access_token: 'sk-ant-oat01-background-access-new',
            expires_in: 3600,
          })
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-old-access',
          refresh: 'old-refresh',
          expires: Date.now() + 5 * 60_000,
        }),
      { models: {} },
    )

    expect(intervalHandlers.length).toBeGreaterThanOrEqual(2)
    for (const handler of intervalHandlers) handler()
    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    // Wait for the background refresh's write itself, not a fixed poll count.
    const { subject } = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-background-access-new',
    )
    const stored = await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).read()
    expect(stored.status).toBe('ready')
    const credential =
      stored.status === 'ready'
        ? stored.rows.find((row) => row.id === subject.binding.rowId)
            ?.credential
        : undefined
    expect(credential).toMatchObject({
      type: 'oauth',
      refresh: 'background-refresh-new',
      access: 'sk-ant-oat01-background-access-new',
      expires: expect.any(Number),
    })
    expect(subject.binding.identity).toBe(syntheticMainAccountUuid)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('background refresh retries after a permanent main backoff belongs to an older refresh token', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          mainAccountId: 'main-account-id',
          quota: { enabled: false },
          refresh: {
            enabled: true,
            refreshBeforeExpiryMinutes: 30,
            mainLastRefreshError: {
              message: 'Claude OAuth refresh failed: 400 — invalid_grant',
              checkedAt: now - 1_000,
              nextRetryAt: now + 24 * 60 * 60_000,
              retryCount: 1,
              accountIdentity: 'main-account-id',
              refreshTokenFingerprint: tokenFingerprint('failed-refresh'),
              status: 400,
              permanent: true,
            },
          },
        }),
        'sk-ant-oat01-current-access',
      ),
      {
        access: 'sk-ant-oat01-current-access',
        refresh: 'current-refresh',
        expires: now + 5 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    let tokenRefreshCalls = 0
    mainAccountIssues('sk-ant-oat01-refreshed-access')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1
          return Response.json({
            refresh_token: 'refreshed-refresh',
            access_token: 'sk-ant-oat01-refreshed-access',
            expires_in: 8 * 60 * 60,
          })
        }
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-current-access',
          refresh: 'current-refresh',
          expires: now + 5 * 60_000,
        }),
      { models: {} },
    )

    for (const handler of intervalHandlers) handler()
    const refreshed = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-refreshed-access',
    )
    expect(refreshed.credential.refresh).toBe('refreshed-refresh')
    expect(refreshed.subject.binding.identity).toBe(syntheticMainAccountUuid)
    expect(tokenRefreshCalls).toBe(1)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  })

  test('reset-backoff clears an imported main latch before the next background refresh', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          mainAccountId: 'main-account-id',
          quota: { enabled: false },
          refresh: {
            enabled: true,
            refreshBeforeExpiryMinutes: 30,
            mainLastRefreshError: {
              message: 'Claude OAuth refresh failed: 400 — invalid_grant',
              checkedAt: now - 1_000,
              nextRetryAt: now + 24 * 60 * 60_000,
              retryCount: 1,
              accountIdentity: syntheticMainAccountUuid,
              tokenHash: hashRefreshToken('current-refresh'),
              status: 400,
              permanent: true,
            },
          },
        }),
        'sk-ant-oat01-current-access',
      ),
      {
        access: 'sk-ant-oat01-current-access',
        refresh: 'current-refresh',
        expires: now + 5 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    let tokenRefreshCalls = 0
    mainAccountIssues('sk-ant-oat01-refreshed-access')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1
          return Response.json({
            refresh_token: 'refreshed-refresh',
            access_token: 'sk-ant-oat01-refreshed-access',
            expires_in: 8 * 60 * 60,
          })
        }
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-current-access',
          refresh: 'current-refresh',
          expires: now + 5 * 60_000,
        }),
      { models: {} },
    )

    expect(
      (await readNativeRuntimeState()).main?.lastRefreshError?.permanent,
    ).toBe(true)
    expect(tokenRefreshCalls).toBe(0)
    expect(
      (
        await applyMenuAction(plugin, 'session-1', {
          sectionId: 'Accounts',
          actionId: 'reset-backoff',
        })
      ).ok,
    ).toBe(true)
    expect(
      (await readNativeRuntimeState()).main?.lastRefreshError,
    ).toBeUndefined()
    for (const handler of intervalHandlers) handler()
    const refreshed = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-refreshed-access',
    )
    expect(refreshed.credential.refresh).toBe('refreshed-refresh')
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    expect(tokenRefreshCalls).toBe(1)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  })

  test('background refresh uses a four-hour minimum window for main oauth', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
        }),
        'sk-ant-oat01-old-access',
      ),
      {
        access: 'sk-ant-oat01-old-access',
        refresh: 'old-refresh',
        expires: Date.now() + 3 * 60 * 60_000,
      },
    )
    const intervalHandlers: Array<() => void> = []
    const setIntervalMock = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval

    mainAccountIssues('sk-ant-oat01-early-access-new')
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        if (extractUrl(input).includes('/v1/oauth/token'))
          return Response.json({
            refresh_token: 'early-refresh-new',
            access_token: 'sk-ant-oat01-early-access-new',
            expires_in: 3600,
          })
        return new Response(null, { status: 200 })
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setInterval: setIntervalMock,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    })
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-old-access',
          refresh: 'old-refresh',
          expires: Date.now() + 3 * 60 * 60_000,
        }),
      { models: {} },
    )

    for (const handler of intervalHandlers) handler()
    const refreshed = await waitForPoolCredential(
      'main',
      'sk-ant-oat01-early-access-new',
    )
    expect(refreshed.credential).toMatchObject({
      type: 'oauth',
      refresh: 'early-refresh-new',
      access: 'sk-ant-oat01-early-access-new',
      expires: expect.any(Number),
    })
    expect(refreshed.subject.binding.identity).toBe(syntheticMainAccountUuid)
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('fetch wrapper backs off main oauth refresh after rate limits', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
        }),
        'sk-ant-oat01-expired',
      ),
      {
        access: 'sk-ant-oat01-expired',
        refresh: 'refresh-token',
        expires: Date.now() - 1000,
      },
    )
    let tokenRefreshCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { type: 'rate_limit_error', message: 'Rate limited' },
            }),
            { status: 429 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh-token',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh failed: 429')
    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh is backed off')

    expect(tokenRefreshCalls).toBe(1)
    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const savedConfig = await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).readSettings()
    expect(savedConfig.status).toBe('ready')
    if (savedConfig.status !== 'ready')
      throw new Error('Expected ready native pool')
    expect(JSON.stringify(savedConfig.settings)).not.toContain(
      'lastRefreshError',
    )
    const savedState = await readNativeRuntimeState()
    expect(savedState.main?.lastRefreshError?.nextRetryAt).toBeGreaterThan(
      Date.now(),
    )
    expect(savedState.main?.lastRefreshError?.status).toBe(429)
    expect(savedState.main?.accountIdentity).toBe(syntheticMainAccountUuid)
    await expect(readFile(getAccountStatePath(), 'utf8')).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })

  for (const sameAccount of [false, true]) {
    test(
      sameAccount
        ? 'successful re-login preserves the current account main quota backoff'
        : 'successful re-login clears a live stale main refresh backoff',
      async () => {
        const now = Date.now()
        const prior = {
          access: 'sk-ant-oat01-prior-login',
          refresh: 'prior-login-refresh',
          expires: now + 8 * 60 * 60_000,
        }
        const quotaRetryAt = now + 60_000
        await useTempAccountFile(
          bindMainAccount(
            createFallbackStorage({
              accounts: [],
              mainAccountId: 'main-account-id',
              quota: {
                enabled: false,
                mainLastQuotaApiError: {
                  message: 'Prior quota failure',
                  status: 429,
                  checkedAt: now - 1000,
                  nextRetryAt: quotaRetryAt,
                  retryCount: 1,
                  accountIdentity: syntheticMainAccountUuid,
                },
              },
              refresh: {
                enabled: true,
                mainLastRefreshError: {
                  message: 'Claude OAuth refresh failed: 400 — invalid_grant',
                  status: 400,
                  checkedAt: now - 1000,
                  nextRetryAt: now + 24 * 60 * 60_000,
                  retryCount: 1,
                  permanent: true,
                  accountIdentity: syntheticMainAccountUuid,
                  tokenHash: hashRefreshToken(prior.refresh),
                },
              },
            }),
            prior.access,
          ),
          prior,
        )
        const successor = {
          access: 'sk-ant-oat01-relogged-main-access',
          refresh: 'relogged-main-refresh',
          expires: now + 8 * 60 * 60_000,
        }
        const identity = sameAccount
          ? syntheticMainAccountUuid
          : ('88888888-2222-4333-8444-555555555555' as ProviderAccountUuid)
        testContext.successorAccess.set(successor.access, identity)
        let tokenRefreshCalls = 0
        const modelAuthorizations: Array<string | null> = []
        globalThis.fetch = mock(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = extractUrl(input)
            if (
              url.includes('/api/claude_cli/bootstrap') &&
              new Headers(init?.headers).get('authorization') ===
                `Bearer ${successor.access}`
            )
              return Response.json({
                oauth_account: { account_uuid: identity },
              })
            const admitted = await nativeBootstrapAnswer(input, init)
            if (admitted) return admitted
            if (url.includes('/v1/oauth/token')) {
              tokenRefreshCalls++
              throw new Error(
                'Unexpected token refresh during known-account re-login',
              )
            }
            if (url.includes('/v1/messages'))
              modelAuthorizations.push(
                new Headers(init?.headers).get('authorization'),
              )
            return Response.json({})
          },
        ) as unknown as typeof fetch
        const mockClient = createMockClient()
        const plugin = await getPlugin(mockClient)
        const result = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...prior }),
          { models: {} },
        )
        const before = await readNativeRuntimeState()
        expect(before.main?.lastRefreshError?.permanent).toBe(true)
        expect(before.main?.lastRefreshError?.nextRetryAt).toBeGreaterThan(now)
        expect(before.main?.lastQuotaApiError?.nextRetryAt).toBe(quotaRetryAt)
        await replacePoolMainLogin(successor, {
          sameAccount,
          accountIdentity: identity,
        })
        const response = await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: '{}',
        })
        expect(response.status).toBe(200)
        expect(modelAuthorizations).toEqual([`Bearer ${successor.access}`])
        expect(tokenRefreshCalls).toBe(0)
        const after = await readNativeRuntimeState()
        expect(after.main?.accountIdentity).toBe(identity)
        expect(after.main?.lastRefreshError).toBeUndefined()
        if (sameAccount) {
          // A refresh restriction belongs to the replaced credentials. Quota
          // backoff belongs to the account UUID and must keep its live deadline.
          expect(after.main?.lastQuotaApiError).toMatchObject({
            accountIdentity: identity,
            status: 429,
            nextRetryAt: quotaRetryAt,
          })
          expect(after.main?.lastQuotaApiError?.nextRetryAt).toBeGreaterThan(
            Date.now(),
          )
        } else expect(after.main?.lastQuotaApiError).toBeUndefined()
        expect(
          (await waitForPoolCredential('main', successor.access)).credential
            .refresh,
        ).toBe(successor.refresh)
        expect(mockClient.auth.set).not.toHaveBeenCalled()
      },
    )
  }

  test('fallback-first uses stale passing fallback quota while quota refresh is in progress even when main refresh is backed off', async () => {
    const now = Date.now()
    const expiredMain = {
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: now - 1_000,
    }
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          refresh: {
            enabled: true,
            intervalMinutes: 10,
            refreshBeforeExpiryMinutes: 240,
            mainLastRefreshError: {
              message:
                'Claude OAuth refresh failed: 400 — {"error":"invalid_grant"}',
              checkedAt: now,
              nextRetryAt: now + 60_000,
              retryCount: 1,
              tokenHash: hashRefreshToken('main-refresh'),
            },
          },
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: now - 10 * 60_000,
                  resetsAt: '2099-01-01T00:00:00Z',
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: now - 10 * 60_000,
                  resetsAt: '2099-01-01T00:00:00Z',
                },
              },
            },
          ],
        }),
      ),
      expiredMain,
    )
    const authorizations: string[] = []

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          throw new Error('Quota refresh is already in progress')
        }
        if (url.includes('/v1/oauth/token')) {
          throw new Error('main refresh should not be attempted')
        }
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response('fallback-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...expiredMain }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback-ok')
    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('fetch wrapper refreshes expired token', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-expired-token',
      refresh: 'old-refresh',
      expires: Date.now() - 1000,
    })
    mainAccountIssues('sk-ant-oat01-new-access')
    const fetchCalls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)
        fetchCalls.push({ url, body: init?.body })

        if (url.includes('/v1/oauth/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired-token',
          refresh: 'old-refresh',
          expires: Date.now() - 1000, // expired
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    // Should have called token endpoint first
    const tokenCall = fetchCalls.find((c) => c.url.includes('/v1/oauth/token'))
    expect(tokenCall).toBeDefined()
    expect(tokenCall!.url).toBe('https://platform.claude.com/v1/oauth/token')
    const tokenBody = JSON.parse(tokenCall!.body!)
    expect(tokenBody.grant_type).toBe('refresh_token')
    expect(tokenBody.refresh_token).toBe('old-refresh')

    // The new tokens are stored in the native account pool, where the next
    // caller receives them; OpenCode's auth store keeps only the placeholder
    // login and is not written.
    expect(await poolMainAccess()).toBe('sk-ant-oat01-new-access')
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    await expectHostActivationNonSecret(
      'sk-ant-oat01-new-access',
      'new-refresh',
    )
  })

  test('fetch wrapper retries transient token refresh failures', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({ accounts: [], quota: { enabled: false } }),
        'sk-ant-oat01-expired',
      ),
      {
        access: 'sk-ant-oat01-expired',
        refresh: 'refresh',
        expires: Date.now() - 1000,
      },
    )
    let tokenRefreshCalls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    mainAccountIssues('sk-ant-oat01-new-access')
    const modelAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const admitted = await nativeBootstrapAnswer(input, init)
        if (admitted) return admitted
        const url = extractUrl(input)
        if (url.includes('/v1/messages'))
          modelAuthorizations.push(
            new Headers(init?.headers).get('authorization'),
          )
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCalls += 1

          if (tokenRefreshCalls === 1) {
            return Promise.resolve(
              new Response('Temporary failure', { status: 500 }),
            )
          }

          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      },
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, undefined, {
      setTimeout: setTimeoutMock,
    })
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })

    expect(tokenRefreshCalls).toBe(2)
    expect(modelAuthorizations).toEqual(['Bearer sk-ant-oat01-new-access'])
    expect(
      (await waitForPoolCredential('main', 'sk-ant-oat01-new-access'))
        .credential.refresh,
    ).toBe('new-refresh')
    // Retry belongs to the shared coordinator. The host must not add another
    // retry loop or write the resulting secret into its activation slot.
    expect(setTimeoutMock).not.toHaveBeenCalled()
    expect(mockClient.auth.set).not.toHaveBeenCalled()
  })

  test('fetch wrapper keeps main oauth retry count bounded when helper also supports retries', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-expired',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    })
    let tokenRefreshCalls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          new Response('Temporary failure', { status: 500 }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient(), undefined, {
      setTimeout: setTimeoutMock,
    })
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh failed: 500')

    expect(tokenRefreshCalls).toBe(3)
  })

  test('fetch wrapper does not retry non-transient token refresh failures', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-expired',
      refresh: 'refresh',
      expires: Date.now() - 1000,
    })
    let tokenRefreshCalls = 0

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(new Response('Forbidden', { status: 403 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired',
          refresh: 'refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    await expect(
      result.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('Claude OAuth refresh failed: 403')

    expect(tokenRefreshCalls).toBe(1)
  })

  test('fetch wrapper strips tool prefix from streaming response', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
      {
        access: 'sk-ant-oat01-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    const encoder = new TextEncoder()
    const responseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_bash"}}\n\ndata: {"type":"message_stop"}\n\n',
          ),
        )
        controller.close()
      },
    })

    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(new Response(responseStream, { status: 200 })),
      ),
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

    const response = await result.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          stream: true,
          tools: [
            { name: 'bash', input_schema: { type: 'object', properties: {} } },
          ],
        }),
      },
    )

    const text = await response.text()
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain('mcp_bash')
  })

  test('concurrent expired token refresh should deduplicate to a single token request', async () => {
    let tokenRefreshCount = 0

    globalThis.fetch = mock(
      withNativeBootstrap((input: any) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader('sk-ant-oat01-new-access')
    await fireConcurrentFetches(result)

    // With deduplication, only ONE refresh request should be made, not 5
    expect(tokenRefreshCount).toBe(1)
  })

  test('plugin instances sharing main auth join a refresh while auth persistence is delayed', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
      {
        access: 'sk-ant-oat01-expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1_000,
      },
    )
    mainAccountIssues('sk-ant-oat01-new-access')
    let tokenRefreshCount = 0
    // Hold the first plugin's exchange open while the second requests
    // credentials. Both must join one refresh, and only the pool stores
    // the returned tokens; OpenCode's activation slot stays unchanged.
    const tokenRequestStarted = lifetimeSignal()
    const tokenResponse = heldResponse()

    globalThis.fetch = mock(
      withNativeBootstrap((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount += 1
          tokenRequestStarted.raise()
          return tokenResponse.response
        }
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const firstClient = createMockClient()
    const secondClient = createMockClient()
    let secondTimerCalls = 0
    const secondRefreshWait = mock(() => {
      secondTimerCalls += 1
      throw new Error('second plugin entered the cross-process refresh wait')
    }) as unknown as typeof setTimeout
    const firstPlugin = await getPlugin(firstClient, '/project-a')
    const secondPlugin = await getPlugin(secondClient, '/project-b', {
      setTimeout: secondRefreshWait,
    })
    const expiredAuth = () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'sk-ant-oat01-expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1_000,
      })
    const firstResult = await firstPlugin.auth.loader(expiredAuth, {
      models: {},
    })
    const secondResult = await secondPlugin.auth.loader(expiredAuth, {
      models: {},
    })

    const firstFetch = firstResult.fetch(MESSAGES_URL, EMPTY_POST)
    await tokenRequestStarted.raised
    const secondFetch = secondResult.fetch(MESSAGES_URL, EMPTY_POST)
    await Bun.sleep(0)
    tokenResponse.release(
      new Response(
        JSON.stringify({
          refresh_token: 'new-refresh',
          access_token: 'sk-ant-oat01-new-access',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

    const responses = await Promise.all([firstFetch, secondFetch]).catch(
      (error) => {
        console.error('shared native refresh mismatch', {
          tokenRefreshCount,
          secondTimerCalls,
        })
        throw error
      },
    )
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(tokenRefreshCount).toBe(1)
    expect(secondRefreshWait).not.toHaveBeenCalled()
    // Both instances share the one refreshed login through the pool, and
    // neither writes token material to OpenCode's auth store.
    expect(await poolMainAccess()).toBe('sk-ant-oat01-new-access')
    expect(tokenRefreshCount).toBe(1)
    expect(firstClient.auth.set).not.toHaveBeenCalled()
    expect(secondClient.auth.set).not.toHaveBeenCalled()
    await expectHostActivationNonSecret(
      'sk-ant-oat01-new-access',
      'new-refresh',
    )
  })

  for (const duringRefresh of [false, true]) {
    test(
      duringRefresh
        ? 'sticky 401 retry persists consumed successor but refuses it after host activation changes'
        : 'sticky 401 retry refuses a foreign-provider tombstone before the token endpoint',
      async () => {
        const checkedAt = Date.now()
        const login = {
          access: 'sk-ant-oat01-live-main-access',
          refresh: 'live-main-refresh',
          expires: checkedAt + 8 * 60 * 60_000,
        }
        await useTempAccountFile(
          bindMainQuotaToAccount(
            createFallbackStorage({
              accounts: [],
              routing: { mode: 'sticky-balanced' },
              quota: {
                enabled: true,
                checkIntervalMinutes: 5,
                minimumRemaining: { five_hour: 1, seven_day: 1 },
                failClosedOnUnknownQuota: true,
                mainQuota: {
                  checkedAt,
                  five_hour: {
                    usedPercent: 10,
                    remainingPercent: 90,
                    checkedAt,
                  },
                  seven_day: {
                    usedPercent: 10,
                    remainingPercent: 90,
                    checkedAt,
                  },
                },
                mainQuotaCheckedAt: checkedAt,
              },
            }),
            login.access,
          ),
          login,
        )
        const pool = testContext.migratedPool
        if (!pool) throw new Error('Expected migrated pool')
        const hostAuthPath = pool.hostAuthPath
        const messageAuthorizations: string[] = []
        const tokenEndpointCalls: string[] = []
        const successor = {
          access: 'sk-ant-oat01-consumed-revoked',
          refresh: 'consumed-revoked-refresh',
        }
        mainAccountIssues(successor.access)
        async function revokeActivation() {
          const authFile = JSON.parse(await readFile(hostAuthPath, 'utf8'))
          authFile.anthropic = {
            ...custodyTombstoneOAuth('openai'),
            access: 'claustrum-tombstone:v1:openai',
            expires: 0,
          }
          await writeFile(hostAuthPath, JSON.stringify(authFile), {
            mode: 0o600,
          })
        }
        globalThis.fetch = mock(
          withNativeBootstrap(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = extractUrl(input)
              if (url === TOKEN_URL) {
                tokenEndpointCalls.push(url)
                if (duringRefresh) {
                  await revokeActivation()
                  return Response.json({
                    access_token: successor.access,
                    refresh_token: successor.refresh,
                    expires_in: 8 * 60 * 60,
                  })
                }
                return Promise.resolve(
                  new Response('unexpected', { status: 200 }),
                )
              }
              if (url.includes('/v1/messages')) {
                messageAuthorizations.push(
                  new Headers(init?.headers).get('authorization') ?? '',
                )
                if (!duringRefresh) await revokeActivation()
                return new Response('unauthorized', { status: 401 })
              }
              return Promise.resolve(new Response('{}', { status: 200 }))
            },
          ),
        ) as unknown as typeof fetch

        const plugin = await getPlugin()
        const result = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...login }),
          { models: {} },
        )

        let refusal: unknown
        try {
          await result.fetch(MESSAGES_URL, {
            method: 'POST',
            headers: { 'x-session-affinity': 'tombstone-sticky-401' },
            body: JSON.stringify({
              model: 'claude-opus-5',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hello' }],
            }),
          })
        } catch (error) {
          refusal = error
        }
        expect(messageAuthorizations).toEqual([
          'Bearer sk-ant-oat01-live-main-access',
        ])
        expect(tokenEndpointCalls).toEqual(duringRefresh ? [TOKEN_URL] : [])
        if (duringRefresh) {
          // The provider already issued replacement credentials, so losing
          // them could leave only an invalid old refresh token. Removing
          // OpenCode's activation blocks model sends, not credential storage.
          expect(
            (await waitForPoolCredential('main', successor.access)).credential
              .refresh,
          ).toBe(successor.refresh)
        }
        expect(
          (await readNativeRuntimeState()).main?.lastRefreshError,
        ).toBeUndefined()
        expect(refusal).toBeInstanceOf(Error)
        expect(
          refusal instanceof Error ? refusal.message : undefined,
        ).toContain('Native OAuth requires inert OpenCode activation')
        await plugin.dispose?.()
      },
    )
  }

  test('physical OAuth authorization refuses host revocation during fresh token validation', async () => {
    const checkedAt = Date.now()
    const login = {
      access: 'sk-ant-oat01-validation-initial',
      refresh: 'validation-refresh',
      expires: checkedAt + 8 * 60 * 60_000,
    }
    const successorAccess = 'sk-ant-oat01-validation-rotated'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'fallback-first' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt },
              seven_day: { usedPercent: 10, remainingPercent: 90, checkedAt },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
        login.access,
      ),
      login,
    )
    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const store = createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    })
    let rotated = false
    let usableAuthorizations = 0
    const factory = Core.createNativeAccountRuntime
    const factorySpy = spyOn(
      Core,
      'createNativeAccountRuntime',
    ).mockImplementation((options) => {
      const runtime = factory(options)
      const authorize = runtime.authorizeLocal.bind(runtime)
      runtime.authorizeLocal = async (...args) => {
        const authorization = await authorize(...args)
        if (authorization.status === 'usable' && ++usableAuthorizations === 2) {
          rotated = true
          const settings = await store.readSettings()
          if (
            settings.status !== 'ready' ||
            typeof settings.settings.mainAccountId !== 'string'
          )
            throw new Error('Expected primary row')
          // The request reads its credential, then chooses a route before sending.
          // Rotate after both steps have authorized the old pool token. The next
          // authorizeLocal call is the last credential check before dispatch.
          // Its /api/claude_cli/bootstrap mock below replaces the Anthropic auth
          // slot with an OpenAI placeholder, which must prevent the model send.
          // Keep host-auth reads passive so extra reads cannot move this revocation.
          await store.rotate(settings.settings.mainAccountId, {
            type: 'oauth',
            access: successorAccess,
            refresh: login.refresh,
            expires: login.expires + 1000,
          })
        }
        return authorization
      }
      return runtime
    })
    bodyLifetime().deferCleanup(() => {
      factorySpy.mockRestore()
    })
    const bootstraps: Array<string | null> = []
    const modelAuthorizations: Array<string | null> = []
    let tokenCalls = 0
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const bearer = new Headers(init?.headers).get('authorization')
        if (url.includes('/api/claude_cli/bootstrap')) {
          bootstraps.push(bearer)
          if (bearer === `Bearer ${successorAccess}`) {
            const authFile = JSON.parse(
              await readFile(pool.hostAuthPath, 'utf8'),
            )
            authFile.anthropic = {
              ...custodyTombstoneOAuth('openai'),
              access: 'claustrum-tombstone:v1:openai',
              expires: 0,
            }
            await writeFile(pool.hostAuthPath, JSON.stringify(authFile), {
              mode: 0o600,
            })
          } else if (bearer !== `Bearer ${login.access}`)
            throw new Error('Unexpected bootstrap credential')
          return Response.json({
            oauth_account: { account_uuid: syntheticMainAccountUuid },
          })
        }
        if (url === TOKEN_URL) tokenCalls++
        if (url.includes('/v1/messages')) modelAuthorizations.push(bearer)
        return Response.json({})
      }),
      { preconnect() {} },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      async () => ({ type: 'oauth', ...login }),
      { models: {} },
    )
    let refusal: unknown
    try {
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'revoked-token-validation' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    } catch (error) {
      refusal = error
    }
    expect(rotated).toBe(true)
    expect(bootstraps).toEqual([
      `Bearer ${login.access}`,
      `Bearer ${successorAccess}`,
    ])
    expect(modelAuthorizations).toEqual([])
    expect(tokenCalls).toBe(0)
    expect(refusal instanceof Error ? refusal.message : undefined).toContain(
      'Native OAuth requires inert OpenCode activation',
    )
    expect(
      (await waitForPoolCredential('main', successorAccess)).credential.refresh,
    ).toBe(login.refresh)
    expect(
      (await readNativeRuntimeState()).main?.lastRefreshError,
    ).toBeUndefined()
  })

  test('sticky 401 retries with a concurrently rotated main access token', async () => {
    const checkedAt = Date.now()
    const oldLogin = {
      access: 'sk-ant-oat01-old-access',
      refresh: 'old-refresh',
      expires: checkedAt + 8 * 60 * 60_000,
    }
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
        oldLogin.access,
      ),
      oldLogin,
    )
    let tokenRefreshCount = 0
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeBootstrap(async (input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount += 1
          return new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          })
        }
        if (url.includes('/v1/messages')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          messageAuthorizations.push(authorization)
          if (authorization === 'Bearer sk-ant-oat01-old-access') {
            // Another OpenCode process refreshes the same account while this
            // request is in flight; the old access token is then rejected.
            await refreshPoolMainElsewhere({
              access: 'sk-ant-oat01-new-access',
              refresh: 'new-refresh',
              expires: checkedAt + 8 * 60 * 60_000,
            })
            return new Response('unauthorized', { status: 401 })
          }
          return new Response('{}', { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth' as const, ...oldLogin }),
      {
        models: {},
      },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-refresh-race' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-old-access',
      'Bearer sk-ant-oat01-new-access',
    ])
    expect(tokenRefreshCount).toBe(0)
  })

  test('serves an existing sticky assignment with a live token', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
      ),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        if (extractUrl(input).includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'unknown-identity-sticky' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const responses = await Promise.all([
      result.fetch(MESSAGES_URL, request),
      result.fetch(MESSAGES_URL, request),
    ])
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
  })

  test('admits and sends an OAuth route when an empty quota snapshot is fail-open', async () => {
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: false,
          },
        }),
      ),
    )
    const usageRequests: string[] = []
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          usageRequests.push(url)
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        if (url.includes('/v1/messages')) {
          messageAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'truly-unknown-quota' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(usageRequests).toHaveLength(1)
    expect(messageAuthorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('unknown identity routes when fail-open, then unknown quota blocks when fail-closed', async () => {
    const storage = createFallbackStorage({
      accounts: [],
      routing: { mode: 'main-first' },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
        failClosedOnUnknownQuota: false,
      },
    })
    await useTempAccountFile(storage)
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response('quota unavailable', { status: 500 }),
          )
        }
        if (url.includes('/v1/messages')) {
          messageAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'unknown-identity-routes' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    const routed = await result.fetch(MESSAGES_URL, request)
    expect(routed.status).toBe(200)

    await updatePoolSettings((settings) => ({
      ...settings,
      quota: { ...storage.quota, failClosedOnUnknownQuota: true },
    }))
    const blocked = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'unknown-quota-blocked' },
    })

    expect(blocked.status).toBe(429)
    expect(await blocked.clone().text()).toContain('Quota API')
    expect(messageAuthorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('keeps a sticky main route excluded during identity-agnostic active refresh backoff', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          routing: { mode: 'sticky-balanced' },
          refresh: {
            enabled: true,
            intervalMinutes: 10,
            refreshBeforeExpiryMinutes: 30,
            // Without an account UUID, the refresh-token hash identifies which
            // credential failed. Migration preserves that retry restriction.
            mainLastRefreshError: {
              message: 'refresh unavailable',
              checkedAt,
              nextRetryAt: checkedAt + 60_000,
              tokenHash: hashRefreshToken('main-refresh'),
            },
          },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt,
              },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
      ),
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/v1/messages')) {
          messageRequests.push(extractUrl(input))
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: checkedAt + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'restricted-unknown-identity' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(429)
    expect(messageRequests).toEqual([])
  })

  test('sticky-balanced routes with a valid fallback token during transient DNS refresh backoff', async () => {
    const now = Date.now()
    const result = await runStickyDnsBackoffScenario({
      tokenExpiresAt: now + 3 * 60 * 60_000,
      refreshErrorCheckedAt: now,
      refreshErrorNextRetryAt: now + 24 * 60 * 60_000,
      refreshErrorRetryCount: 1,
    })

    expect(result.response.status).toBe(200)
    expect(result.tokenRequests).toEqual([])
    expect(result.messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-initial-fallback-access',
    ])
  })

  test('sticky-balanced refreshes an expired fallback after repeated DNS failures', async () => {
    const now = Date.now()
    const result = await runStickyDnsBackoffScenario({
      tokenExpiresAt: now - 60_000,
      refreshErrorCheckedAt: now - 6 * 60_000,
      refreshErrorNextRetryAt: now + 54 * 60_000,
      refreshErrorRetryCount: 7,
    })

    expect(result.response.status).toBe(200)
    expect(result.tokenRequests).toHaveLength(1)
    expect(result.messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-refreshed-fallback-access',
    ])
  })

  test('concurrent refresh with token rotation should not cause cascading failures', async () => {
    const usedRefreshTokens = new Set<string>()

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          const body = JSON.parse(String(init?.body))
          const refreshToken = body.refresh_token ?? ''

          // Simulate refresh token rotation: first use succeeds, subsequent uses
          // return 401 because the old token has been invalidated
          if (usedRefreshTokens.has(refreshToken)) {
            return Promise.resolve(
              new Response(JSON.stringify({ error: 'invalid_grant' }), {
                status: 401,
              }),
            )
          }

          usedRefreshTokens.add(refreshToken)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'rotated-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader('sk-ant-oat01-new-access')

    // Fire 5 concurrent requests — ALL should succeed because only one refresh
    // fires and the rest reuse its result
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        result.fetch(MESSAGES_URL, EMPTY_POST).then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      ),
    )

    // With deduplication, all callers share the single successful refresh.
    // Without it, 4 out of 5 get 401 from the rotated-away token → cascading failures.
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  test('concurrent refresh should persist tokens exactly once', async () => {
    let tokenRefreshCount = 0
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init?: RequestInit) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          tokenRefreshCount++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'new-refresh',
                access_token: 'sk-ant-oat01-new-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }
        if (url.includes('/v1/messages'))
          messageAuthorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const { mockClient, result } = await setupExpiredTokenLoader(
      'sk-ant-oat01-new-access',
    )
    await fireConcurrentFetches(result)

    // Refreshed main tokens are stored in the native account pool, never in
    // OpenCode's auth store, which keeps only the placeholder login. All five
    // requests use the single refreshed token, and the pool hands that same
    // token to a later caller without another token request: the refresh was
    // persisted once and reused, not repeated per request.
    expect(mockClient.auth.set).not.toHaveBeenCalled()
    await expectHostActivationNonSecret(
      'sk-ant-oat01-new-access',
      'new-refresh',
    )
    expect(messageAuthorizations).toEqual(
      Array.from({ length: 5 }, () => 'Bearer sk-ant-oat01-new-access'),
    )
    expect(await poolMainAccess()).toBe('sk-ant-oat01-new-access')
    expect(tokenRefreshCount).toBe(1)
  })

  test('refresh always reads the latest refresh token, not a stale snapshot', async () => {
    const tokenRequestBodies: string[] = []
    const staleLogin = {
      access: 'sk-ant-oat01-expired-access',
      refresh: 'stale-refresh',
      expires: Date.now() - 1000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      staleLogin,
    )
    mainAccountIssues('sk-ant-oat01-fresh-access')

    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init: any) => {
        const url = extractUrl(input)

        if (url.includes('/v1/oauth/token')) {
          tokenRequestBodies.push(init?.body)
          return Promise.resolve(
            new Response(
              JSON.stringify({
                refresh_token: 'rotated-refresh',
                access_token: 'sk-ant-oat01-fresh-access',
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          )
        }

        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...staleLogin }),
      { models: {} },
    )
    // After the loader started, a re-login elsewhere stores a newer refresh
    // token for the same account in the pool. The refresh must use it.
    await replacePoolMainLogin({
      access: 'sk-ant-oat01-expired-access',
      refresh: 'rotated-refresh-from-storage',
      expires: Date.now() - 1000,
    })

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRequestBodies).toHaveLength(1)
    const sentBody = JSON.parse(tokenRequestBodies[0] ?? '{}')
    expect(sentBody.refresh_token).toBe('rotated-refresh-from-storage')
    expect(sentBody.refresh_token).not.toBe('stale-refresh')
  })
})
