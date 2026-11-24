import { afterEach, beforeEach, describe, expect, mock } from 'bun:test'
import {
  __setLogTestSink,
  type AccountStorage,
  createNativeAccountRuntime,
  isNativeLocalCredentialValidation,
  isOAuthAccount,
  type LogTestRecord,
  type OAuthAccount,
  SERVER_SIDE_FALLBACK_BETA,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { drainSidebarWrites, type getSidebarState } from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import type { createMockClient } from './support/opencode1-client.ts'
import {
  installLoaderSetup,
  setUserRefusalFallbackMode,
} from './support/opencode1-loader-setup.ts'
import {
  bindMainAccount,
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  replacePoolMainLogin as replacePoolMainLoginWithCtx,
  syntheticFallbackAccountUuid,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  updatePoolSettings as updatePoolSettingsWithCtx,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import { waitForLogRecord as waitForLogRecordWithCtx } from './support/opencode1-quota.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForAccountStorage,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  drainBeforeReset,
  EMPTY_POST,
  getBodyLifetime,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
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
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
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
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}
function waitForLogRecord(
  records: LogTestRecord[],
  predicate: (record: LogTestRecord) => boolean,
  description: string,
) {
  return waitForLogRecordWithCtx(testContext, records, predicate, description)
}

describe('killswitch fetch gate', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    // Prevent this plugin instance's background intervals from leaking into
    // later tests without mutating process-global timers used by other files.
    testContext.pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
  })

  afterEach(async () => {
    await drainBeforeReset(testContext.testLifetime, () => {
      globalThis.fetch = originalFetch
      testContext.pluginRuntimeOverrides = {}
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    })
  })

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100000,
    })

  test('Ultra fresh weekly-only poll selects the local OpenCode 1 account', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: true, failClosedOnUnknownQuota: true },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )
    let messages = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            Response.json({
              five_hour: null,
              seven_day: { utilization: 0 },
            }),
          )
        }
        messages++
        return Promise.resolve(new Response('ultra-ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ultra-ok')
    expect(messages).toBe(1)
  })

  // Main below the soft routing threshold but ABOVE the killswitch threshold,
  // with no fallbacks: the killswitch must not hard-block — the request falls
  // through to main as it would with the killswitch disabled.
  test('does not 429 when main is only below the routing threshold', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              // Main has 8% five-hour quota: below the 10% routing minimum,
              // but above the 5% hard-block threshold. Weekly quota is healthy.
              JSON.stringify({
                five_hour: { utilization: 92 },
                seven_day: { utilization: 40 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('message-ok')
  })

  // Main killed (below killswitch threshold) with a non-replayable body and a
  // healthy fallback: the fallback cannot accept the request, so the killswitch
  // must 429 rather than silently serving the killed main account.
  test('429s a non-replayable request when main is killed even if a fallback is alive', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          // Main's 2% remaining quota triggers the hard block. The fallback
          // account has 90% remaining and can serve instead.
          const utilization = authorization.includes('sk-ant-oat01-main-access')
            ? 98
            : 10
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization },
                seven_day: { utilization: 10 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hi'))
        controller.close()
      },
    })

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit)

    expect(response.status).toBe(429)
    expect(await response.text()).toContain('Killswitch')
  })

  test('429s a replayable request when main is killed and the only fallback passes killswitch but fails routing quota policy', async () => {
    // The fallback is above its killswitch threshold (so it passes the
    // killswitch quota check) but below the routing minimumRemaining, so
    // getUsableFallbackAccounts — and therefore routing — drops it. The 429
    // decision must be derived from the routable set, not the storage snapshot,
    // so the request is hard-blocked instead of falling through to the killed
    // main account.
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let mainServed = false
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          // Main's 2% five-hour quota triggers the hard block. The fallback's
          // 7% passes the 5% hard-block threshold but not the 10% routing minimum.
          const fiveHourUtil = authorization.includes(
            'sk-ant-oat01-main-access',
          )
            ? 98
            : 93
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: fiveHourUtil },
                seven_day: { utilization: 50 },
              }),
              { status: 200 },
            ),
          )
        }
        mainServed = true
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    expect(await response.text()).toContain('Killswitch')
    // Must NOT have fallen through to the killswitched main account.
    expect(mainServed).toBe(false)
  })

  test('fallback-first routing does not serve from a killswitch-killed fallback', async () => {
    // killswitch threshold (5h:50) is higher than the routing minimumRemaining
    // (5h:10): a fallback at 30% passes routing policy but is killswitch-killed.
    // fallback-first must NOT serve from it — it should fall through to the
    // healthy main account instead.
    const storage = createFallbackStorage({
      routing: { mode: 'fallback-first' },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 10, seven_day: 20 },
        failClosedOnUnknownQuota: false,
      },
      killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'sk-ant-oat01-fallback-access',
          refresh: 'fallback-refresh',
          expires: Date.now() + 5 * 60 * 60 * 1000,
        },
      ],
    })
    const fallback = storage.accounts.find(
      (account) => account.id === 'fallback-1',
    )
    if (!fallback || !isOAuthAccount(fallback))
      throw new Error('Missing killswitch fixture fallback')
    delete fallback.quota
    await useTempAccountFile(storage)
    const initialFallback = (await readAccountStorage())?.accounts.find(
      (account): account is OAuthAccount =>
        account.id === 'fallback-1' && isOAuthAccount(account),
    )
    expect(initialFallback?.quota).toBeUndefined()

    let servedAuth: string | undefined
    const quotaAuthorizations: string[] = []
    const modelAuthorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            const authorization =
              new Headers(init?.headers).get('authorization') ?? ''
            quotaAuthorizations.push(authorization)
            const isMain = authorization.includes('sk-ant-oat01-main-access')
            // Main has 80% remaining and can serve. The fallback's 30% passes
            // the 10% routing minimum but fails its 50% hard-block threshold.
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: isMain ? 20 : 70 },
                  seven_day: { utilization: isMain ? 20 : 50 },
                }),
                { status: 200 },
              ),
            )
          }
          servedAuth = new Headers(init?.headers).get('authorization') ?? ''
          modelAuthorizations.push(servedAuth)
          return Promise.resolve(new Response('message-ok', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    if (!servedAuth?.includes('sk-ant-oat01-main-access')) {
      // Capture policy state only after a wrong route; diagnostics must not
      // change the ordering of a successful quota preflight.
      if (!testContext.migratedPool)
        throw new Error('Missing native killswitch fixture')
      const reader = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      try {
        const snapshot = await reader.read()
        console.error('killswitch route mismatch', {
          usageCalls: quotaAuthorizations.map((value) =>
            value.includes('sk-ant-oat01-main-access')
              ? 'main'
              : value.includes('sk-ant-oat01-fallback-access')
                ? 'fallback'
                : 'other',
          ),
          killswitch: snapshot.policyStorage.killswitch,
          accounts: snapshot.accounts.map((account) => ({
            id: account.id,
            fiveHourUsed: account.quota?.five_hour?.usedPercent,
            fiveHourRemaining: account.quota?.five_hour?.remainingPercent,
            quotaCheckedAt: account.quota?.checkedAt,
            state: account.state,
          })),
        })
      } finally {
        reader.close()
      }
    }
    expect(servedAuth).toContain('sk-ant-oat01-main-access')
    expect(servedAuth).not.toContain('sk-ant-oat01-fallback-access')
    const again = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(again.status).toBe(200)
    expect(modelAuthorizations).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(quotaAuthorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
  })

  test('fail-closed killswitch blocks the first request when main quota is unknown', async () => {
    // failClosedOnUnknownQuota=true: on the first request the quota API is down,
    // so the eager refresh fails and main quota stays unknown. The killswitch
    // must treat main as killed (fail-closed) and 429 rather than fall through
    // to main — even before the quota-API backoff is armed.
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
        killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      }),
    )

    let mainServed = false
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          // The failed usage request cannot establish main account quota,
          // so fail-closed policy must keep model dispatch blocked.
          return Promise.resolve(
            new Response('upstream error', { status: 500 }),
          )
        }
        mainServed = true
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    expect(mainServed).toBe(false)
  })

  test('sidebar marks the fallback active when the killswitch routes to it', async () => {
    // killswitch threshold (5h:50) is above the routing minimumRemaining
    // (5h:10): main at 30% passes routing (so the routing writeback optimistically
    // sets the sidebar to 'main') but is killswitch-killed, so the killswitch gate
    // hands off to the healthy fallback. The sidebar's active account must be
    // corrected to that fallback, not left showing 'main'.
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
          const isMain = authorization.includes('sk-ant-oat01-main-access')
          // Main's 30% five-hour quota passes routing but triggers its 50%
          // hard block. The fallback has 90%; both weekly windows are healthy.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: isMain ? 70 : 10 },
                seven_day: { utilization: 10 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    const state = await waitForSidebarState((s) => s.activeId === 'fallback-1')
    expect(state.activeId).toBe('fallback-1')
  })

  test('killswitch returns the surviving fallback error rather than falling through to the killed main', async () => {
    // main is killswitch-killed; a surviving fallback is tried but returns 429.
    // The killswitch is a hard block, so the request must surface the fallback's
    // real error — never retry on the killed main.
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: false,
        },
        killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let mainServed = false
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        if (url.includes('/api/oauth/usage')) {
          const isMain = authorization.includes('sk-ant-oat01-main-access')
          // Main's 30% remaining quota triggers its 50% hard block despite
          // passing routing. The fallback account has 90% and passes both.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: isMain ? 70 : 10 },
                seven_day: { utilization: 10 },
              }),
              { status: 200 },
            ),
          )
        }
        if (authorization.includes('sk-ant-oat01-main-access')) {
          mainServed = true
          return Promise.resolve(new Response('main-ok', { status: 200 }))
        }
        // The fallback account passes quota policy, but its model request
        // receives a rate limit; the killed main must remain excluded.
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'fallback-limited' }), {
            status: 429,
          }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(429)
    const body = await response.text()
    expect(body).toContain('fallback-limited')
    expect(body).not.toContain('Killswitch: no routable')
    expect(mainServed).toBe(false)
  })
})

describe('main account quota and identity', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('main account replacement fences quota and backoff by account identity', async () => {
    const uuidA = syntheticMainAccountUuid
    const uuidB = syntheticFallbackAccountUuid(99)
    const accessA = 'sk-ant-oat01-token-a'
    const accessB = 'sk-ant-oat01-token-b'
    const checkedAt = Date.now()
    const oldPollEntered = bodyLifetime().gate()
    const releaseOldPoll = bodyLifetime().gate()
    let priorPoll: Promise<unknown> | undefined
    let modelRequest: Promise<Response> | undefined
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: false,
            mainQuota: {
              source: 'poll',
              checkedAt,
              five_hour: { usedPercent: 100, remainingPercent: 0, checkedAt },
            },
            mainQuotaCheckedAt: checkedAt,
          },
        }),
        accessA,
        uuidA,
      ),
      {
        access: accessA,
        refresh: 'refresh-a',
        expires: checkedAt + 8 * 60 * 60_000,
      },
    )
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const token = new Headers(init?.headers).get('authorization')
        if (url.includes('/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: {
              account_uuid: token === `Bearer ${accessA}` ? uuidA : uuidB,
            },
          })
        if (url.includes('/api/oauth/usage')) {
          if (token === `Bearer ${accessA}`) {
            oldPollEntered.open()
            await releaseOldPoll.wait
            return new Response('rate limited', { status: 429 })
          }
          return Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          })
        }
        if (url.includes('/v1/messages'))
          return new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.2',
              'anthropic-ratelimit-unified-7d-utilization': '0.3',
            },
          })
        return Response.json({})
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: accessA,
          refresh: 'refresh-a',
          expires: checkedAt + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const quotaManager = getPluginTestHandles(plugin).quotaManager
    try {
      const oldRequest = quotaManager.refreshMain(uuidA, accessA)
      priorPoll = oldRequest
      bodyLifetime().trackDetached(Promise.allSettled([oldRequest]))
      await Promise.race([
        oldPollEntered.wait,
        oldRequest.then(() => {
          throw new Error('Old poll did not reach the usage endpoint')
        }),
      ])
      await replacePoolMainLogin(
        {
          access: accessB,
          refresh: 'refresh-b',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        { sameAccount: false, accountIdentity: uuidB },
      )
      // The old usage request fails after credentials have been replaced.
      // Its error must not impose backoff on the replacement account.
      releaseOldPoll.open()
      await expect(priorPoll).rejects.toThrow('429')
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      modelRequest = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
      bodyLifetime().trackDetached(Promise.allSettled([modelRequest]))
      const response = await modelRequest
      expect(response.status).toBe(200)
      await response.text()
      await waitForAccountStorage(
        testContext,
        (storage) =>
          storage?.quota?.mainQuota?.accountIdentity === uuidB &&
          storage.quota.mainQuota.five_hour?.usedPercent === 20,
      )
      expect(quotaManager.getMain(uuidA)).toBeNull()
      expect(quotaManager.getMain(uuidB)?.quota.accountIdentity).toBe(uuidB)
      await quotaManager.refreshMain(uuidB, accessB)
      expect(
        quotaManager.getMain(uuidB)?.quota.five_hour?.remainingPercent,
      ).toBe(90)
      expect(quotaManager.isBackedOff()).toBe(false)
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
    } finally {
      releaseOldPoll.open()
      await Promise.allSettled([priorPoll, modelRequest])
    }
  })

  test('sustained unknown account identity retains the fail-closed spend gate', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-unknown'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainLastQuotaApiError: {
              message: 'account A quota backoff',
              checkedAt: now - 1_000,
              nextRetryAt: now + 60_000,
              retryCount: 1,
              accountIdentity: syntheticMainAccountUuid,
            },
          },
        }),
        access,
      ),
      { access, refresh: 'refresh-b', expires: now + 8 * 60 * 60_000 },
    )
    let messageCalls = 0
    let credentialCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (
          url.includes('/v1/oauth/token') ||
          url.includes('/claude_cli/bootstrap')
        )
          credentialCalls++
        if (url.includes('/claude_cli/bootstrap'))
          return Promise.resolve(
            new Response('bootstrap unavailable', { status: 503 }),
          )
        if (url.includes('/v1/messages')) {
          messageCalls++
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh: 'refresh-b',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
    await expect(request).resolves.toMatchObject({ status: 429 })
    const response = await request
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(messageCalls).toBe(0)
    expect(credentialCalls).toBe(0)
    expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(true)
    expect(
      (await readAccountStorage())?.quota?.mainLastQuotaApiError
        ?.accountIdentity,
    ).toBe(syntheticMainAccountUuid)
  })

  test('fresh account-wide exhaustion blocks primary credential acquisition', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-fresh-exhaustion'
    const refresh = 'refresh-fresh-exhaustion'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
                resetsAt: new Date(now + 120_000).toISOString(),
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
          },
        }),
        access,
      ),
      { access, refresh, expires: now + 8 * 60 * 60_000 },
    )
    let calls = 0
    globalThis.fetch = Object.assign(
      mock(() => {
        calls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh,
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(
      118,
    )
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(120)
    expect(calls).toBe(0)
  })

  test('rounded header percentages cannot preempt primary credential acquisition', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-rounded-header'
    const refresh = 'refresh-rounded-header'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            mainQuota: {
              source: 'headers',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
          },
        }),
        access,
      ),
      { access, refresh, expires: now + 8 * 60 * 60_000 },
    )
    let bootstrapCalls = 0
    let modelCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          bootstrapCalls++
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: syntheticMainAccountUuid },
            }),
          )
        }
        if (url.includes('/v1/messages')) modelCalls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh,
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1,
        messages: [
          { role: 'user', content: 'synthetic rounded-header control' },
        ],
      }),
    })
    expect(response.status).toBe(200)
    expect(bootstrapCalls).toBeGreaterThan(0)
    expect(modelCalls).toBe(1)
  })

  test('permanent main refresh failure is not masked by active usage backoff', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-permanent-refresh-quota'
    const refresh = 'refresh-permanent-quota'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainLastQuotaApiError: {
              message: 'usage wait',
              checkedAt: now,
              nextRetryAt: now + 60_000,
              accountIdentity: syntheticMainAccountUuid,
            },
          },
        }),
        access,
      ),
      { access, refresh, expires: now + 8 * 60 * 60_000 },
    )
    if (!testContext.migratedPool)
      throw new Error('This test has no migrated pool')
    let refreshCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        if (!extractUrl(input).includes('/v1/oauth/token'))
          throw new Error(
            'Unexpected request while preparing a permanent refresh failure',
          )
        refreshCalls++
        return Promise.resolve(
          Response.json({ error: 'invalid_grant' }, { status: 400 }),
        )
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
    })
    try {
      expect(
        (await runtime.authorizeLocal('main', { rejectedAccessToken: access }))
          .status,
      ).toBe('failed')
      expect(refreshCalls).toBe(1)
      expect(
        (await runtime.read()).accounts.find((account) => account.id === 'main')
          ?.lastRefreshError?.permanent,
      ).toBe(true)
    } finally {
      runtime.close()
    }
    let calls = 0
    globalThis.fetch = Object.assign(
      mock(() => {
        calls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh,
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    await expect(
      result.fetch(MESSAGES_URL, {
        ...EMPTY_POST,
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1,
          messages: [
            { role: 'user', content: 'synthetic permanent-failure control' },
          ],
        }),
      }),
    ).rejects.toThrow('Claude OAuth refresh is backed off')
    expect(calls).toBe(0)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError?.permanent,
    ).toBe(true)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError?.status,
    ).toBe(400)
  })

  test('expired account usage backoff permits credential validation and dispatch', async () => {
    const now = Date.now()
    const access = 'sk-ant-oat01-expired-usage-backoff'
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainLastQuotaApiError: {
              message: 'expired usage backoff',
              checkedAt: now - 60_000,
              nextRetryAt: now - 1,
              retryCount: 1,
              accountIdentity: syntheticMainAccountUuid,
            },
          },
        }),
        access,
      ),
      {
        access,
        refresh: 'refresh-expired-usage-backoff',
        expires: now + 8 * 60 * 60_000,
      },
    )
    let bootstrapCalls = 0
    let modelCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          bootstrapCalls++
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: syntheticMainAccountUuid },
            }),
          )
        }
        if (url.includes('/v1/messages')) modelCalls++
        return Promise.resolve(Response.json({}))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access,
          refresh: 'refresh-expired-usage-backoff',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
    expect(bootstrapCalls).toBeGreaterThan(0)
    expect(modelCalls).toBe(1)
    expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(false)
  })

  test('confirmed account replacement clears the prior account backoff', async () => {
    const now = Date.now()
    const uuidA = syntheticMainAccountUuid
    const uuidB = syntheticFallbackAccountUuid(96)
    const accessA = 'sk-ant-oat01-account-a'
    const accessB = 'sk-ant-oat01-account-b'
    const oldError = {
      message: 'account A quota backoff',
      checkedAt: now - 1_000,
      nextRetryAt: now + 60_000,
      retryCount: 1,
      accountIdentity: uuidA,
    }
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: true,
            mainLastQuotaApiError: oldError,
            mainQuotaErrorGeneration: 1,
          },
        }),
        accessA,
        uuidA,
      ),
      { access: accessA, refresh: 'refresh-a', expires: now + 8 * 60 * 60_000 },
    )
    let messageCalls = 0
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const token = new Headers(init?.headers).get('authorization')
        if (url.includes('/claude_cli/bootstrap'))
          return Promise.resolve(
            Response.json({
              oauth_account: {
                account_uuid: token === `Bearer ${accessA}` ? uuidA : uuidB,
              },
            }),
          )
        if (url.includes('/api/oauth/usage'))
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 20 },
            }),
          )
        if (url.includes('/v1/messages')) messageCalls++
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: accessA,
          refresh: 'refresh-a',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    expect(
      (await readAccountStorage())?.quota?.mainLastQuotaApiError
        ?.accountIdentity,
    ).toBe(uuidA)
    expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(true)
    if (!testContext.migratedPool)
      throw new Error('This test has no migrated pool')
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
    })
    try {
      const oldSubject = await runtime.captureLocalSubject('main')
      if (!isNativeLocalCredentialValidation(oldSubject))
        throw new Error('Main subject is not account and version bound')
      await replacePoolMainLogin(
        {
          access: accessB,
          refresh: 'refresh-b',
          expires: now + 8 * 60 * 60_000,
        },
        { sameAccount: false, accountIdentity: uuidB },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(response.status).toBe(200)
      expect(messageCalls).toBe(1)
      expect(getPluginTestHandles(plugin).quotaManager.isBackedOff()).toBe(
        false,
      )
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      expect(
        await runtime.publishLocal(oldSubject, {
          lastQuotaRefreshError: oldError,
        }),
      ).toBe(false)
      expect(
        (await readAccountStorage())?.quota?.mainLastQuotaApiError,
      ).toBeUndefined()
      expect(
        (await runtime.read()).accounts.find((account) => account.id === 'main')
          ?.accountIdentity,
      ).toBe(uuidB)
    } finally {
      runtime.close()
    }
  })

  test('discards main response headers resolved under a replaced identity', async () => {
    const uuidA = syntheticMainAccountUuid
    const uuidB = syntheticFallbackAccountUuid(97)
    const tokenA = 'sk-ant-oat01-race-token-a'
    const tokenB = 'sk-ant-oat01-race-token-b'
    const now = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: false,
            mainQuota: {
              source: 'poll',
              checkedAt: now,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
          },
        }),
        tokenA,
        uuidA,
      ),
      { access: tokenA, refresh: 'refresh-a', expires: now + 8 * 60 * 60_000 },
    )
    const started = bodyLifetime().gate()
    const release = bodyLifetime().gate()
    let inFlight: Promise<Response> | undefined
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = extractUrl(input)
        const token = new Headers(init?.headers).get('authorization')
        if (url.includes('/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: {
              account_uuid: token === `Bearer ${tokenA}` ? uuidA : uuidB,
            },
          })
        if (url.includes('/api/oauth/usage'))
          return Response.json({
            five_hour: { utilization: 60 },
            seven_day: { utilization: 70 },
          })
        if (url.includes('/v1/messages')) {
          if (token === `Bearer ${tokenA}`) {
            started.open()
            await release.wait
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.1',
                'anthropic-ratelimit-unified-7d-utilization': '0.2',
              },
            })
          }
          return new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.6',
              'anthropic-ratelimit-unified-7d-utilization': '0.7',
            },
          })
        }
        return Response.json({})
      }),
      {
        preconnect() {
          throw new Error('Unexpected preconnect in test fixture')
        },
      },
    )
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: tokenA,
          refresh: 'refresh-a',
          expires: now + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('trace')
    try {
      inFlight = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
      bodyLifetime().trackDetached(Promise.allSettled([inFlight]))
      await Promise.race([
        started.wait,
        inFlight.then(() => {
          throw new Error('Old model request did not reach the expected sender')
        }),
      ])
      await replacePoolMainLogin(
        {
          access: tokenB,
          refresh: 'refresh-b',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        { sameAccount: false, accountIdentity: uuidB },
      )
      const currentResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(currentResponse.status).toBe(200)
      await currentResponse.text()
      await waitForAccountStorage(
        testContext,
        (storage) =>
          storage?.quota?.mainQuota?.accountIdentity === uuidB &&
          storage.quota.mainQuota.five_hour?.usedPercent === 60,
      )
      expect(
        getPluginTestHandles(plugin).quotaManager.getMain(uuidB)?.quota
          .five_hour?.usedPercent,
      ).toBe(60)
      release.open()
      expect((await inFlight).status).toBe(200)
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'discarded stale main quota headers',
        'old account header discard',
      )
      expect(
        getPluginTestHandles(plugin).quotaManager.getMain(uuidA),
      ).toBeNull()
      expect(
        getPluginTestHandles(plugin).quotaManager.getMain(uuidB)?.quota
          .five_hour?.usedPercent,
      ).toBe(60)
      await getPluginTestHandles(plugin).scopedRuntime.close()
      expect(
        (await readAccountStorage())?.quota?.mainQuota?.accountIdentity,
      ).toBe(uuidB)
      expect(
        (await readAccountStorage())?.quota?.mainQuota?.five_hour?.usedPercent,
      ).toBe(60)
    } finally {
      release.open()
      await Promise.allSettled([inFlight])
      await drainSidebarWrites()
      __setLogTestSink(null)
      setLogLevel('info')
    }
  })
})

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('routes Fable requests to OAuth fallback when main scoped Fable quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
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
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now(),
                },
              ],
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
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
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 25,
                    remainingPercent: 75,
                    checkedAt: Date.now(),
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('keeps non-Fable requests on main when only main Fable quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
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
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now(),
                },
              ],
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test.each([
    { killswitch: false, mode: 'main-first' },
    { killswitch: true, mode: 'main-first' },
    { killswitch: false, mode: 'fallback-first' },
    { killswitch: true, mode: 'fallback-first' },
  ] as const)(
    'does not route API-key fallback for scoped Fable exhaustion alone (%s)',
    async ({ killswitch, mode }) => {
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            routing: { mode },
            ...(killswitch
              ? {
                  killswitch: {
                    enabled: true,
                    main: { five_hour: 0, seven_day: 0, scoped: 10 },
                  },
                }
              : {}),
            quota: {
              enabled: true,
              checkIntervalMinutes: 5,
              minimumRemaining: { five_hour: 10, seven_day: 20 },
              failClosedOnUnknownQuota: true,
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
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 100,
                    remainingPercent: 0,
                    checkedAt: Date.now(),
                  },
                ],
              },
              mainQuotaCheckedAt: Date.now(),
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            } as AccountStorage['quota'],
            accounts: [
              {
                id: 'kie-opus',
                label: 'Kie Opus',
                type: 'api',
                apiKey: 'kie-key',
                baseURL: 'https://api.kie.ai/claude',
                authHeader: 'authorization-bearer',
              },
            ],
          }),
        ),
      )

      const requests: Array<{ url: string; authorization: string | null }> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
            requests.push({
              url,
              authorization: new Headers(init?.headers).get('authorization'),
            })
            return Promise.resolve(new Response(null, { status: 200 }))
          },
        ),
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
        body: JSON.stringify({
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(response.status).toBe(killswitch ? 429 : 200)
      if (killswitch) {
        expect(requests).toHaveLength(0)
        return
      }
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        authorization: 'Bearer sk-ant-oat01-main-access',
      })
    },
  )

  test('refreshes stale scoped Fable exhaustion before skipping main', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
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
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now() - 60 * 60 * 1000,
                },
              ],
            },
            mainQuotaCheckedAt: Date.now() - 60 * 60 * 1000,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            quotaCalls++
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0 },
                  seven_day: { utilization: 0 },
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent: 10,
                      resets_at: null,
                      scope: { model: { id: null, display_name: 'Fable' } },
                    },
                  ],
                }),
                { status: 200 },
              ),
            )
          }
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.authorization).toBe('Bearer sk-ant-oat01-main-access')
  })

  test('killswitch fallback handoff filters exhausted matching scoped model quota', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          killswitch: {
            enabled: true,
            main: { five_hour: 50, seven_day: 20 },
          },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 70,
                remainingPercent: 30,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt: now,
              },
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: now,
                },
              ],
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'fallback-empty',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-empty-access',
              refresh: 'fallback-empty-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 100,
                    remainingPercent: 0,
                    checkedAt: now,
                  },
                ],
              },
            },
            {
              id: 'fallback-ok',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-ok-access',
              refresh: 'fallback-ok-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 25,
                    remainingPercent: 75,
                    checkedAt: now,
                  },
                ],
              },
            },
          ],
        }),
      ),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 70 },
                  seven_day: { utilization: 10 },
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent: 10,
                      resets_at: null,
                      scope: { model: { id: null, display_name: 'Fable' } },
                    },
                  ],
                }),
                { status: 200 },
              ),
            )
          }
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-fallback-ok-access'])
  })

  test('does not route to API-key fallback when main OAuth quota is low but not exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'https://api.anthropic.com/v1/messages?beta=true',
    )
    expect(requests[0]?.authorization).toBe('Bearer sk-ant-oat01-main-access')
  })

  test('routes to API-key fallback when cached main OAuth quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              checkedAt: Date.now(),
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 50,
                remainingPercent: 50,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.kie.ai/claude/v1/messages?beta=true',
      authorization: 'Bearer kie-key',
    })
  })

  test('does not route to API-key fallback from stale cached main OAuth exhaustion', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now() - 60 * 60_000,
              },
              seven_day: {
                usedPercent: 50,
                remainingPercent: 50,
                checkedAt: Date.now() - 60 * 60_000,
              },
            },
            mainQuotaCheckedAt: Date.now() - 60 * 60 * 1000,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            quotaCalls++
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 10 },
                  seven_day: { utilization: 10 },
                }),
                { status: 200 },
              ),
            )
          }
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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

    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
    })
  })

  test('does not use API-key route in fallback-first before main quota is exhausted', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'kie-opus',
              label: 'Kie Opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
        }),
      ),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 10 },
                  seven_day: { utilization: 10 },
                }),
                { status: 200 },
              ),
            )
          }
          requests.push({
            url,
            authorization: new Headers(init?.headers).get('authorization'),
          })
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
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

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-fallback-access',
    })
  })

  test('native turnEndNote settings affect OAuth only, not the API-key proxy fallback', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          minimumRemaining: { five_hour: 10 },
          failClosedOnUnknownQuota: true,
        },
        accounts: [
          {
            id: 'paid',
            type: 'api',
            apiKey: 'synthetic-paid',
            baseURL: 'https://proxy.invalid',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )
    await updatePoolSettings((settings) => ({
      ...settings,
      turnEndNote: { tools: ['my_cleanup'] },
    }))
    const bodies: any[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        if (extractUrl(input).includes('/api/oauth/usage'))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 50 },
              }),
            ),
          )
        bodies.push(JSON.parse(String(init?.body)))
        return Promise.resolve(
          new Response(null, { status: bodies.length === 1 ? 429 : 200 }),
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
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        messages: [
          { role: 'user', content: 'Question' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'A'.repeat(350) },
              { type: 'tool_use', name: 'my_cleanup', id: 'a', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'a', content: 'Done' },
            ],
          },
        ],
      }),
    })
    expect(bodies).toHaveLength(2)
    expect(bodies[0].messages.at(-1)).toMatchObject({
      role: 'system',
      clear_at: 'next_user_message',
    })
    expect(bodies[1].messages).toHaveLength(3)
    expect(bodies[1].messages.at(-1).role).toBe('user')
  })

  test('routes to API-key fallback after main OAuth returns 429 and strips server fallback fields from the custom provider request', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'kie-opus',
            label: 'Kie Opus',
            type: 'api',
            apiKey: 'kie-key',
            baseURL: 'https://api.kie.ai/claude',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )

    await setUserRefusalFallbackMode(testContext, 'server')
    const requests: Array<{
      url: string
      authorization: string | null
      beta: string | null
      body: Record<string, unknown>
    }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        const headers = new Headers(init?.headers)
        const authorization = headers.get('authorization')
        if (url.includes('/api/oauth/usage')) {
          quotaCalls++
          expect(authorization).toBe('Bearer sk-ant-oat01-main-access')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 50 },
              }),
              { status: 200 },
            ),
          )
        }
        requests.push({
          url,
          authorization,
          beta: headers.get('anthropic-beta'),
          body: JSON.parse(String(init?.body)),
        })
        if (requests.length === 1) {
          return Promise.resolve(
            new Response('main exhausted', { status: 429 }),
          )
        }
        return Promise.resolve(new Response(null, { status: 200 }))
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
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
      body: expect.objectContaining({ fallbacks: 'default' }),
    })
    expect(requests[0]?.beta?.split(',')).toContain(SERVER_SIDE_FALLBACK_BETA)
    expect(requests[1]).toMatchObject({
      url: 'https://api.kie.ai/claude/v1/messages?beta=true',
      authorization: 'Bearer kie-key',
    })
    expect(requests[1]?.body).not.toHaveProperty('fallbacks')
    // An API-key request has no injected Claude Code betas.
    expect(requests[1]?.beta).toBeNull()
  })

  test('does not route to API-key fallback after main 429 when quota does not confirm exhaustion', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'kie-opus',
            label: 'Kie Opus',
            type: 'api',
            apiKey: 'kie-key',
            baseURL: 'https://api.kie.ai/claude',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        const authorization = new Headers(init?.headers).get('authorization')
        if (url.includes('/api/oauth/usage')) {
          quotaCalls++
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.25 },
              }),
              { status: 200 },
            ),
          )
        }
        requests.push({ url, authorization })
        return Promise.resolve(
          new Response('transient rate limit', { status: 429 }),
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

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(429)
    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
    })
  })

  test('does not route to API-key fallback after non-quota main OAuth fallback status', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'kie-opus',
            label: 'Kie Opus',
            type: 'api',
            apiKey: 'kie-key',
            baseURL: 'https://api.kie.ai/claude',
            authHeader: 'authorization-bearer',
          },
        ],
      }),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        requests.push({
          url: extractUrl(input),
          authorization: new Headers(init?.headers).get('authorization'),
        })
        return Promise.resolve(new Response('auth failure', { status: 403 }))
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
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(403)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer sk-ant-oat01-main-access',
    })
  })

  for (const bound of [true, false]) {
    test(
      bound
        ? 'fallback-first reuses migrated account-bound main quota for sidebar without refetching'
        : 'fallback-first refuses legacy main quota attributed only to an old access token',
      async () => {
        const checkedAt = Date.now()
        const storage = createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: { usedPercent: 6, remainingPercent: 94, checkedAt },
              seven_day: { usedPercent: 75, remainingPercent: 25, checkedAt },
              checkedAt,
            },
            mainQuotaCheckedAt: checkedAt,
          },
        })
        for (const account of storage.accounts) {
          if (account.type !== 'oauth') continue
          account.expires = checkedAt + 8 * 60 * 60_000
          account.quota = {
            checkedAt,
            five_hour: { usedPercent: 30, remainingPercent: 70, checkedAt },
            seven_day: { usedPercent: 40, remainingPercent: 60, checkedAt },
          }
        }
        bindPoolAccounts(storage)
        if (!bound && storage.quota?.mainQuota) {
          storage.quota.mainQuota.accountIdentity = undefined
          storage.quota.mainQuotaToken = tokenFingerprint('old-main-access')
        }
        await useTempAccountFile(storage)
        const imported = await readNativeRuntimeState()
        expect(imported.main?.accountIdentity).toBe(syntheticMainAccountUuid)
        if (bound)
          expect(imported.main?.quota).toMatchObject({
            accountIdentity: syntheticMainAccountUuid,
            five_hour: { usedPercent: 6 },
            seven_day: { usedPercent: 75 },
          })
        else expect(imported.main?.quota).toBeUndefined()

        const authorizations: string[] = []
        let mainQuotaCalls = 0
        globalThis.fetch = mock(
          withNativeAdmission(
            (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = extractUrl(input)
              if (url.includes('/api/oauth/usage')) {
                mainQuotaCalls++
                expect(new Headers(init?.headers).get('authorization')).toBe(
                  'Bearer sk-ant-oat01-main-access',
                )
                return Promise.resolve(
                  new Response(
                    JSON.stringify({
                      five_hour: { utilization: 12 },
                      seven_day: { utilization: 34 },
                    }),
                    { status: 200 },
                  ),
                )
              }

              authorizations.push(
                new Headers(init?.headers).get('authorization') ?? '',
              )
              return Promise.resolve(new Response(null, { status: 200 }))
            },
          ),
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

        const state = await waitForSidebarState(
          (candidate) =>
            candidate.activeId === 'fallback-1' &&
            (bound
              ? candidate.main.quota?.five_hour?.usedPercent === 6
              : candidate.main.quota === null),
        )
        expect(state.route).toBe('fallback-first')
        if (bound) expect(state.main.quota?.seven_day?.usedPercent).toBe(75)
        else expect(state.main.quota).toBeNull()
        expect(mainQuotaCalls).toBe(0)
        expect(authorizations[0]).toBe('Bearer sk-ant-oat01-fallback-access')
      },
    )
  }
})
