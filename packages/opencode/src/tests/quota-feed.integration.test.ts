import { afterEach, describe, expect, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  getClaudeCodeIdentityForVerifiedAccount,
  hashRefreshToken,
  isNativeLocalCredentialValidation,
  isOAuthAccount,
  type LogTestRecord,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import {
  drainSidebarWrites,
  type getSidebarState,
  getSidebarStateFile,
} from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import type { createMockClient } from './support/opencode1-client.ts'
import {
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  loginIssues as loginIssuesWithCtx,
  mainAccountIssues as mainAccountIssuesWithCtx,
  nativeAdmissionAnswer as nativeAdmissionAnswerWithCtx,
  poolMainIdentity as poolMainIdentityWithCtx,
  publishNativeMainQuota as publishNativeMainQuotaWithCtx,
  refreshPoolLoginElsewhere as refreshPoolLoginElsewhereWithCtx,
  refreshPoolMainElsewhere as refreshPoolMainElsewhereWithCtx,
  syntheticFallbackAccountUuid,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withMainAdmission as withMainAdmissionWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
  withNativeBootstrap as withNativeBootstrapWithCtx,
  withNativeTokenExchange as withNativeTokenExchangeWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  expectNonOatMainRefused as expectNonOatMainRefusedWithCtx,
  expectUnknownQuotaAdmissionBlocked as expectUnknownQuotaAdmissionBlockedWithCtx,
  loadMainAndFetch as loadMainAndFetchWithCtx,
  readFeedEntries,
  waitForFeedEntries as waitForFeedEntriesWithCtx,
  waitForLogRecord as waitForLogRecordWithCtx,
} from './support/opencode1-quota-feed.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForAccountStorage as waitForAccountStorageWithCtx,
  waitForNativePoolQuota as waitForNativePoolQuotaWithCtx,
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
  setSidebarWriteTestHooks as setSidebarWriteTestHooksWithCtx,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
}
function __setSidebarStateWriteTestHooks(
  hooks: Parameters<typeof setSidebarWriteTestHooksWithCtx>[1],
  stateFile: string = getSidebarStateFile(),
) {
  return setSidebarWriteTestHooksWithCtx(testContext, hooks, stateFile)
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
function withNativeTokenExchange<Input, Init>(
  handler: (input: Input, init: Init) => Response | Promise<Response>,
) {
  return withNativeTokenExchangeWithCtx(testContext, handler)
}
function poolMainIdentity(): string {
  return poolMainIdentityWithCtx(testContext)
}
function mainAccountIssues(...accesses: string[]) {
  return mainAccountIssuesWithCtx(testContext, ...accesses)
}
function loginIssues(current: string, ...accesses: string[]) {
  return loginIssuesWithCtx(testContext, current, ...accesses)
}
function nativeAdmissionAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  return nativeAdmissionAnswerWithCtx(testContext, input, init)
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
function refreshPoolMainElsewhere(successor: {
  access: string
  refresh: string
  expires: number
}) {
  return refreshPoolMainElsewhereWithCtx(testContext, successor)
}
function refreshPoolLoginElsewhere(
  routeId: string,
  successor: { access: string; refresh: string; expires: number },
) {
  return refreshPoolLoginElsewhereWithCtx(testContext, routeId, successor)
}
function publishNativeMainQuota(quota: OAuthQuotaSnapshot) {
  return publishNativeMainQuotaWithCtx(testContext, quota)
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
function waitForAccountStorage(
  predicate: (storage: AccountStorage | null) => boolean,
) {
  return waitForAccountStorageWithCtx(testContext, predicate)
}
function waitForNativePoolQuota(
  routeId: string,
  predicate: (quota: OAuthQuotaSnapshot | undefined) => boolean,
  options?: { keepAliveUntil?: Promise<unknown> },
) {
  return waitForNativePoolQuotaWithCtx(testContext, routeId, predicate, options)
}
function waitForFeedEntries(
  predicate: (entries: Awaited<ReturnType<typeof readFeedEntries>>) => boolean,
  description: string,
) {
  return waitForFeedEntriesWithCtx(testContext, predicate, description)
}
function waitForLogRecord(
  records: LogTestRecord[],
  predicate: (record: LogTestRecord) => boolean,
  description: string,
) {
  return waitForLogRecordWithCtx(testContext, records, predicate, description)
}
function loadMainAndFetch(
  storage: AccountStorage,
  response: Response | (() => Response),
  requestHeaders?: Record<string, string>,
) {
  return loadMainAndFetchWithCtx(testContext, storage, response, requestHeaders)
}
function expectNonOatMainRefused(access: string) {
  return expectNonOatMainRefusedWithCtx(testContext, access)
}
function expectUnknownQuotaAdmissionBlocked(storage: AccountStorage) {
  return expectUnknownQuotaAdmissionBlockedWithCtx(testContext, storage)
}

async function deferModelRequestUntilTeardown() {
  await useTempAccountFile(
    createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
  )
  let modelRequests = 0
  globalThis.fetch = mock(
    withNativeAdmission((input: Parameters<typeof fetch>[0]) => {
      expect(extractUrl(input)).toContain('/v1/messages')
      modelRequests++
      return new Response('{}', { status: 200 })
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
    { models: {} },
  )
  const warmup = await result.fetch(MESSAGES_URL, EMPTY_POST)
  expect(warmup.status).toBe(200)
  await warmup.text()
  const send = bodyLifetime().gate()
  // Teardown releases the registered send, just as it releases an interrupted
  // body's gates. Its fetch stub must remain installed until the send settles.
  bodyLifetime().trackDetached(
    send.wait.then(async () => {
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(response.status).toBe(200)
      await response.text()
      expect(modelRequests).toBe(2)
    }),
  )
  expect(modelRequests).toBe(1)
}

describe('fallback quota persistence ordering', () => {
  test('does not restore a late quota error older than the persisted success', async () => {
    const successAt = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-late-error',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: successAt + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 10,
                  remainingPercent: 90,
                  checkedAt: successAt,
                },
                seven_day: {
                  usedPercent: 20,
                  remainingPercent: 80,
                  checkedAt: successAt,
                },
              },
            },
          ],
        }),
      ),
    )

    if (!testContext.migratedPool)
      throw new Error('Missing native quota fixture')
    const identity = testContext.poolLogins.find(
      (login) => login.access === 'sk-ant-oat01-fallback-access',
    )?.identity
    if (!identity) throw new Error('Missing fallback fixture identity')
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
      local: {
        refreshToken: async () => ({
          access: 'sk-ant-oat01-fallback-access',
          refresh: 'fallback-refresh',
          expires: successAt + 5 * 60 * 60 * 1_000,
          expiresIn: 5 * 60 * 60,
        }),
        resolveIdentity: async () =>
          getClaudeCodeIdentityForVerifiedAccount(
            'fallback-late-error',
            identity as ProviderAccountUuid,
          ),
        now: () => successAt,
      },
    })
    const plugin = await getPlugin()
    try {
      const authorized = await runtime.authorizeLocal('fallback-late-error')
      expect(authorized.status).toBe('usable')
      if (authorized.status !== 'usable')
        throw new Error(
          `Fallback quota fixture is not authorized: ${authorized.status}`,
        )
      let quotaRequests = 0
      await runtime.fetchQuota(
        'fallback-late-error',
        Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            expect(extractUrl(input)).toBe(
              'https://api.anthropic.com/api/oauth/usage',
            )
            quotaRequests++
            return Response.json({
              five_hour: { utilization: 10, resets_at: null },
              seven_day: { utilization: 20, resets_at: null },
            })
          },
          {
            preconnect() {
              throw new Error('Unexpected fixture preconnect')
            },
          },
        ),
      )
      expect(quotaRequests).toBe(1)
      expect(
        (await readAccountStorage())?.accounts.find(
          (account): account is OAuthAccount =>
            account.id === 'fallback-late-error' && isOAuthAccount(account),
        )?.quota?.five_hour?.usedPercent,
      ).toBe(10)
      await runtime.publishLocal(authorized.subject, {
        lastQuotaRefreshError: {
          message: 'older quota failure',
          checkedAt: successAt - 1,
          nextRetryAt: successAt + 60_000,
          retryCount: 1,
          accountIdentity: identity,
        },
      })
    } finally {
      runtime.close()
    }
    await plugin.dispose?.()

    const saved = await readAccountStorage()
    const savedAccount = saved?.accounts[0]
    expect(savedAccount).toBeDefined()
    if (!savedAccount || !isOAuthAccount(savedAccount)) {
      throw new Error('missing persisted fallback account')
    }
    expect(savedAccount.lastQuotaRefreshError).toBeUndefined()
  })
})

describe('quota header feed integration', () => {
  const originalFetch = globalThis.fetch

  afterEach(async () => {
    await drainBeforeReset(testContext.testLifetime, () => {
      globalThis.fetch = originalFetch
    })
  })

  test(
    'drains a deferred model request before restoring its fetch stub',
    deferModelRequestUntilTeardown,
  )

  test.serial(
    'non-OAT compatibility identity stays a local quota key without a provider uuid',
    async () => {
      // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
      // refused with guidance and nothing reaches the model or the quota feed.
      await expectNonOatMainRefused('local-adapter-access')
    },
  )

  async function publishFallbackUuid({
    fallbackUuid,
    persistedUuid,
    bootstrapResponse,
  }: {
    fallbackUuid: string
    persistedUuid?: ProviderAccountUuid
    bootstrapResponse: unknown
  }) {
    const fallbackAccess = `sk-ant-oat-${randomUUID()}`
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
        quotaHeaderFeed: { enabled: true },
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: fallbackAccess,
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            ...(persistedUuid && { anthropicAccountUuid: persistedUuid }),
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
    )
    if (persistedUuid) {
      // First confirm the token's account UUID through the bootstrap endpoint.
      // Its saved validation then permits serving when a later account lookup
      // returns no UUID; a stored UUID alone must never authorize the token.
      const answer = withNativeAdmission(() => Response.json({}))
      globalThis.fetch = Object.assign(
        mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const response = await answer(input, init)
          if (!(response instanceof Response))
            throw new Error('Admission fixture must return a Response')
          return response
        }),
        { preconnect: originalFetch.preconnect },
      )
      const runtime = createNativeAccountRuntime({
        paths: testContext.migratedPool!.paths,
        host: 'opencode',
      })
      try {
        expect((await runtime.authorizeLocal('fallback-1')).status).toBe(
          'usable',
        )
      } finally {
        runtime.close()
      }
    }
    // Answer token exchanges and the primary account's bootstrap normally.
    // Let this test control the fallback credential's bootstrap response.
    globalThis.fetch = mock(
      withNativeTokenExchange(
        withMainAdmission((input: any, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(Response.json(bootstrapResponse))
          }
          if (url.includes('/v1/messages')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            if (authorization === `Bearer ${fallbackAccess}`) {
              return Promise.resolve(
                new Response('{}', {
                  status: 200,
                  headers: {
                    'anthropic-ratelimit-unified-5h-utilization': '0.25',
                  },
                }),
              )
            }
            return Promise.resolve(new Response(null, { status: 429 }))
          }
          return Promise.resolve(Response.json({}))
        }),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    await response.text()

    const [published] = await waitForFeedEntries(
      (entries) =>
        entries.some(
          (entry: any) => entry.anthropic_account_uuid === fallbackUuid,
        ),
      'a fallback UUID feed entry',
    )
    const persisted = await waitForAccountStorage(
      (candidate) =>
        (
          candidate?.accounts.find(
            (account) => account.id === 'fallback-1',
          ) as any
        )?.anthropicAccountUuid === fallbackUuid,
    )
    return { published, persisted }
  }

  test('does not treat a complete but uncommitted .tmp lease as a published feed entry', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const directory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'pretend.json.uncommitted.tmp'),
      JSON.stringify({
        version: 3,
        entries: { a: { account_ref: 'not-yet-published' } },
      }),
      { mode: 0o600 },
    )
    expect(await readFeedEntries()).toEqual([])
  })

  test('non-oat main feed leaves provider UUID null while retaining its quota slot', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('main-access')
  })

  test('oat main feed preserves its bootstrapped Anthropic account UUID', async () => {
    const mainAccountId = 'main-oat-slot'
    const providerAccountUuid = '33333333-3333-3333-3333-333333333333'
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId,
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
      {
        access: 'sk-ant-oat-main-feed',
        refresh: 'main-refresh',
        expires: Date.now() + 100_000,
      },
    )
    globalThis.fetch = mock(
      withNativeTokenExchange((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: providerAccountUuid },
            }),
          )
        }
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
          }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat-main-feed',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    await response.text()

    const [published] = await waitForFeedEntries(
      (entries) =>
        entries.some(
          (entry: any) => entry.anthropic_account_uuid === providerAccountUuid,
        ),
      'a bootstrapped main UUID feed entry',
    )
    // The native feed keys the main account by its stable Claude account
    // UUID; the configured slot id stays a local name only.
    expect(published).toEqual(
      expect.objectContaining({
        account_ref: providerAccountUuid,
        anthropic_account_uuid: providerAccountUuid,
      }),
    )
    expect((published as { account_ref?: unknown }).account_ref).not.toBe(
      mainAccountId,
    )
  })

  test('main feed drops a cached oat UUID after the current credential becomes non-oat', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('main-feed-non-oat-after-rotation')
  })

  test('fresh non-oat main install persists a quota slot and publishes no provider UUID', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('fresh-main-non-oat')
  })

  test('publishes and persists a fallback Anthropic account UUID', async () => {
    const fallbackUuid = '11111111-1111-1111-1111-111111111111'
    const { published, persisted } = await publishFallbackUuid({
      fallbackUuid,
      bootstrapResponse: { oauth_account: { account_uuid: fallbackUuid } },
    })
    expect(published).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: 'fallback-1',
        anthropic_account_uuid: fallbackUuid,
      }),
    )
    expect(
      (
        persisted?.accounts.find(
          (account) => account.id === 'fallback-1',
        ) as any
      )?.anthropicAccountUuid,
    ).toBe(fallbackUuid)
  })

  test('uses a persisted fallback Anthropic account UUID before bootstrap resolves it', async () => {
    const fallbackUuid = '22222222-2222-2222-2222-222222222222'
    const { published, persisted } = await publishFallbackUuid({
      fallbackUuid,
      persistedUuid: fallbackUuid as ProviderAccountUuid,
      bootstrapResponse: {},
    })
    expect(published).toEqual(
      expect.objectContaining({
        account_ref: 'fallback-1',
        anthropic_account_uuid: fallbackUuid,
      }),
    )
    expect(
      (
        persisted?.accounts.find(
          (account) => account.id === 'fallback-1',
        ) as any
      )?.anthropicAccountUuid,
    ).toBe(fallbackUuid)
  })

  test('cache-seeded poll fields survive a later header harvest into the feed', async () => {
    const originalNow = Date.now
    let clock = 1_000_000
    Date.now = () => clock
    try {
      const mainAccountId = syntheticMainAccountUuid
      const accessToken = 'sk-ant-oat01-cache-seeded'
      const pollCheckedAt = 900_000
      const initialPollQuota: OAuthQuotaSnapshot = {
        source: 'poll',
        accountIdentity: mainAccountId,
        checkedAt: pollCheckedAt,
        five_hour: {
          usedPercent: 4,
          remainingPercent: 96,
          checkedAt: pollCheckedAt,
        },
        seven_day: {
          usedPercent: 52,
          remainingPercent: 48,
          checkedAt: pollCheckedAt,
        },
        bindingWindow: 'claude-weekly-scoped-fable',
        bindingWindowSource: 'poll',
      }
      const scoped = [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 55,
          remainingPercent: 45,
          checkedAt: pollCheckedAt,
        },
      ]
      const extraUsage: NonNullable<OAuthQuotaSnapshot['extraUsage']> = {
        used: { amountMinor: 1261, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        utilizationPercent: 12.61,
        severity: 'normal',
        exhausted: false,
      }
      const storage = bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId,
          quotaHeaderFeed: { enabled: true },
          accounts: [],
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: initialPollQuota,
            mainQuotaCheckedAt: pollCheckedAt,
            mainQuotaToken: tokenFingerprint(accessToken),
          },
        }),
        accessToken,
        mainAccountId,
      )
      await useTempAccountFile(storage, {
        access: accessToken,
        refresh: 'main-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      })
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
      let startPollWriter: () => Promise<void> = async () => {
        throw new Error('Poll writer is not ready')
      }
      let modelRequests = 0
      globalThis.fetch = mock(
        withNativeAdmission(async (input: Parameters<typeof fetch>[0]) => {
          if (extractUrl(input).includes('/v1/messages')) {
            if (modelRequests++ === 0) await startPollWriter()
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.04',
                'anthropic-ratelimit-unified-7d-utilization': '0.52',
              },
            })
          }
          throw new Error(`Unexpected test endpoint: ${extractUrl(input)}`)
        }),
      ) as unknown as typeof fetch
      const pollSubject = await publishNativeMainQuota(initialPollQuota)
      if (!testContext.migratedPool) throw new Error('Missing migrated fixture')
      const entered = bodyLifetime().gate()
      const release = bodyLifetime().gate()
      // Pause a real poll flush while a header is accepted. A later harvest
      // must retain the poll's fields once that flush has reached disk.
      const writer = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
        beforePoolWrite: async () => {
          entered.open()
          await release.wait
        },
      })
      let pollWriter: ReturnType<typeof writer.publishLocal> | undefined
      startPollWriter = async () => {
        pollWriter = writer.publishLocal(pollSubject, {
          quota: { ...initialPollQuota, scoped, extraUsage },
        })
        bodyLifetime().trackDetached(pollWriter)
        expect(await pollWriter).toBe(true)
        await entered.wait
      }
      let firstRequest: Promise<Response> | undefined
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      try {
        const plugin = await getPlugin()
        const result = await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: accessToken,
              refresh: 'main-refresh',
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )
        setLogLevel('trace')
        // Release the poll after header receipt. Acceptance need not wait for
        // either store's queued quota to reach disk.
        const pollFieldsWritten = waitForNativePoolQuota(
          'main',
          (quota) =>
            Bun.deepEquals(quota?.scoped, scoped) &&
            Bun.deepEquals(quota?.extraUsage, extraUsage),
        )
        bodyLifetime().trackDetached(pollFieldsWritten)
        firstRequest = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
        bodyLifetime().trackDetached(firstRequest)
        await entered.wait
        const cache = getPluginTestHandles(plugin).quotaManager
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'response quota awaiting publication' &&
            record.payload?.account === 'main',
          'header receipt while the poll flush is held',
        )
        expect(cache.getMain(mainAccountId)?.quota.bindingWindow).toBe(
          'claude-weekly-scoped-fable',
        )
        release.open()
        if (!pollWriter)
          throw new Error(
            'First model request did not start the native poll writer',
          )
        expect(await pollWriter).toBe(true)
        await pollFieldsWritten
        await writer.close()
        expect((await readAccountStorage())?.quota?.mainQuota?.scoped).toEqual(
          scoped,
        )
        const firstResponse = await firstRequest
        expect(firstResponse.status).toBe(200)
        await firstResponse.text()
        const persisted = await waitForNativePoolQuota(
          'main',
          (quota) =>
            quota?.five_hour?.checkedAt === clock &&
            quota.seven_day?.checkedAt === clock,
        )
        expect(persisted?.checkedAt).toBe(pollCheckedAt)
        expect((await readAccountStorage())?.quota?.mainQuota?.scoped).toEqual(
          scoped,
        )
        // Storage acceptance does not wait for the detached feed write.
        await waitForFeedEntries(
          (entries) =>
            entries.some(
              (entry) =>
                entry !== null &&
                typeof entry === 'object' &&
                'observed_at_ms' in entry &&
                entry.observed_at_ms === clock,
            ),
          'first header observation',
        )
        clock += 1_000
        const secondResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
        expect(secondResponse.status).toBe(200)
        await secondResponse.text()
        const secondEntry = (
          await waitForFeedEntries(
            (entries) =>
              entries.length === 1 &&
              entries[0] !== null &&
              typeof entries[0] === 'object' &&
              'observed_at_ms' in entries[0] &&
              entries[0].observed_at_ms === clock,
            'second header observation',
          )
        )[0]
        if (
          secondEntry === null ||
          typeof secondEntry !== 'object' ||
          !('quota' in secondEntry)
        )
          throw new Error('Published feed entry has no quota')
        const quota = secondEntry.quota
        if (quota === null || typeof quota !== 'object')
          throw new Error('Published quota is not an object')
        expect('scoped' in quota ? quota.scoped : undefined).toEqual(scoped)
        expect('extraUsage' in quota ? quota.extraUsage : undefined).toEqual(
          extraUsage,
        )
        expect('bindingWindow' in quota ? quota.bindingWindow : undefined).toBe(
          'claude-weekly-scoped-fable',
        )
      } finally {
        release.open()
        await Promise.allSettled([pollWriter, firstRequest])
        await writer.close()
        __setLogTestSink(null)
        setLogLevel('info')
      }
    } finally {
      Date.now = originalNow
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    }
  })

  test('same-account token rotation preserves poll-owned quota during header harvest', async () => {
    const originalNow = Date.now
    const clock = 1_000_000
    Date.now = () => clock
    try {
      const mainAccountId = syntheticMainAccountUuid
      const pollAccessToken = 'sk-ant-oat01-poll-token'
      const rotatedAccessToken = 'sk-ant-oat01-rotated-token'
      const pollCheckedAt = 900_000
      const scoped = [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 55,
          remainingPercent: 45,
          checkedAt: pollCheckedAt,
        },
      ]
      const extraUsage = {
        used: { amountMinor: 1261, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        utilizationPercent: 12.61,
        severity: 'normal',
        exhausted: false,
      }
      const initialPollQuota: OAuthQuotaSnapshot = {
        source: 'poll',
        accountIdentity: mainAccountId,
        checkedAt: pollCheckedAt,
        five_hour: {
          usedPercent: 4,
          remainingPercent: 96,
          checkedAt: pollCheckedAt,
        },
        seven_day: {
          usedPercent: 52,
          remainingPercent: 48,
          checkedAt: pollCheckedAt,
        },
        scoped,
        extraUsage,
        bindingWindow: 'claude-weekly-scoped-fable',
        bindingWindowSource: 'poll',
      }
      const storage = createFallbackStorage({
        mainAccountId,
        accounts: [],
        quota: {
          ...createFallbackStorage().quota,
          mainQuota: initialPollQuota,
          mainQuotaCheckedAt: pollCheckedAt,
          mainQuotaToken: tokenFingerprint(pollAccessToken),
        },
      })
      await useTempAccountFile(
        bindMainQuotaToAccount(storage, pollAccessToken, mainAccountId),
        {
          access: pollAccessToken,
          refresh: 'poll-refresh-token',
          expires: clock + 8 * 60 * 60_000,
        },
      )
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
      const served: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (!extractUrl(input).includes('/v1/messages'))
              throw new Error(`Unexpected test endpoint: ${extractUrl(input)}`)
            served.push(new Headers(init?.headers).get('authorization'))
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.11',
                'anthropic-ratelimit-unified-7d-utilization': '0.22',
              },
            })
          },
        ),
      ) as unknown as typeof fetch
      mainAccountIssues(rotatedAccessToken)
      await refreshPoolLoginElsewhere('main', {
        access: rotatedAccessToken,
        refresh: 'rotated-refresh-token',
        expires: clock + 5 * 60 * 60_000,
      })

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: pollAccessToken,
            refresh: 'poll-refresh-token',
            expires: clock + 8 * 60 * 60_000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await response.text()

      const persisted = await waitForAccountStorage(
        (candidate) =>
          candidate?.quota?.mainQuota?.five_hour?.checkedAt === clock &&
          candidate.quota.mainQuota.seven_day?.checkedAt === clock,
      )
      expect(persisted?.quota?.mainQuota?.checkedAt).toBe(pollCheckedAt)
      expect(persisted?.quota?.mainQuota?.five_hour?.usedPercent).toBe(11)
      expect(persisted?.quota?.mainQuota?.seven_day?.usedPercent).toBe(22)
      expect(persisted?.quota?.mainQuota?.scoped).toEqual(scoped)
      expect(persisted?.quota?.mainQuota?.extraUsage).toEqual(extraUsage)
      expect(persisted?.quota?.mainQuota?.bindingWindow).toBe(
        'claude-weekly-scoped-fable',
      )
      expect(persisted?.quota?.mainQuotaToken).toBe(mainAccountId)
      expect(served).toEqual([`Bearer ${rotatedAccessToken}`])
    } finally {
      Date.now = originalNow
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    }
  })

  test('stale fallback headers do not persist or publish after re-login', async () => {
    const fallbackAccess = 'sk-ant-oat01-fallback-lineage-a-access'
    const fallbackCheckedAt = Date.now()
    const responseGate = bodyLifetime().gate()
    const startedGate = bodyLifetime().gate()
    let fallbackValue = new Response('{}', { status: 503 })
    const fallbackResponse = responseGate.wait.then(() => fallbackValue)
    const releaseFallbackResponse = (response: Response) => {
      fallbackValue = response
      responseGate.open()
    }
    const fallbackStarted = () => startedGate.open()
    const fallbackRequestStarted = startedGate.wait
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          quota: {
            ...createFallbackStorage().quota,
            checkIntervalMinutes: 60,
          },
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: fallbackAccess,
              refresh: 'fallback-lineage-a-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              authLineageId: 'lineage-a',
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: fallbackCheckedAt,
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: fallbackCheckedAt,
                },
              },
            },
          ],
        }),
      ),
    )
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          const token = new Headers(init?.headers).get('authorization')
          if (token === `Bearer ${fallbackAccess}`) {
            fallbackStarted?.()
            return fallbackResponse
          }
          return Promise.resolve(new Response(null, { status: 429 }))
        }
        return Promise.resolve(Response.json({}))
      }),
    ) as unknown as typeof fetch

    const records: LogTestRecord[] = []
    let responsePromise: Promise<Response> | undefined
    let fallbackAtPersistenceReject: unknown
    const sidebarStates: unknown[] = []
    try {
      const plugin = await getPlugin()
      setLogLevel('trace')
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const quotaManager = getPluginTestHandles(plugin).quotaManager
      __setLogTestSink((record) => {
        records.push(record)
        if (
          record.channel === 'quota' &&
          record.message === 'native quota publication refused'
        ) {
          queueMicrotask(() => {
            fallbackAtPersistenceReject = quotaManager
              .getAllFallbacks()
              .get('fallback-1')
          })
        }
      })
      responsePromise = Promise.resolve(
        result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
        }),
      )
      bodyLifetime().trackDetached(responsePromise)
      await Promise.race([
        fallbackRequestStarted,
        responsePromise.then(() => {
          throw new Error(
            'Request completed without reaching the expected fallback',
          )
        }),
      ])
      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBe(25)
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks({
        beforeRename: async (_stateFile, tempFile) => {
          sidebarStates.push(JSON.parse(await readFile(tempFile, 'utf8')))
        },
      })

      if (!testContext.migratedPool) throw new Error('Missing migrated pool')
      const replacementRuntime = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      const newAccess = 'sk-ant-oat01-fallback-lineage-b-access'
      loginIssues(fallbackAccess, newAccess)
      try {
        await replacementRuntime.loginOAuth({
          routeId: 'fallback-1',
          accountIdentity: syntheticFallbackAccountUuid(0),
          replace: true,
          credential: {
            access: newAccess,
            refresh: 'fallback-lineage-b-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
        })
        const subject =
          await replacementRuntime.captureLocalSubject('fallback-1')
        if (!isNativeLocalCredentialValidation(subject))
          throw new Error(
            'Replacement subject has no exact account and credential version',
          )
        expect(
          await replacementRuntime.publishLocal(subject, {
            quota: {
              accountIdentity: subject.binding.identity,
              checkedAt: fallbackCheckedAt,
              five_hour: {
                usedPercent: 60,
                remainingPercent: 40,
                checkedAt: fallbackCheckedAt,
              },
              seven_day: {
                usedPercent: 70,
                remainingPercent: 30,
                checkedAt: fallbackCheckedAt,
              },
            },
          }),
        ).toBe(true)
      } finally {
        await replacementRuntime.close()
      }
      const replacedAccount = (await readAccountStorage())?.accounts.find(
        (account) => account.id === 'fallback-1',
      )
      if (!replacedAccount || !isOAuthAccount(replacedAccount))
        throw new Error('Replacement OAuth account is missing')
      expect(replacedAccount.quota?.five_hour?.usedPercent).toBe(60)
      setLogLevel('trace')

      releaseFallbackResponse?.(
        new Response('{}', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.04',
            'anthropic-ratelimit-unified-7d-utilization': '0.12',
          },
        }),
      )
      const response = await responsePromise
      expect(response.status).toBe(200)
      await response.text()

      await waitForLogRecord(
        records,
        (record) =>
          record.level === 'debug' &&
          record.channel === 'quota' &&
          record.message === 'native quota publication refused' &&
          record.payload?.accountId === 'fallback-1',
        'stale fallback quota persistence discard',
      )
      await drainSidebarWrites()
      const settled = await readAccountStorage()
      const settledAccount = settled?.accounts.find(
        (candidate) => candidate.id === 'fallback-1',
      )
      expect(
        settledAccount && isOAuthAccount(settledAccount)
          ? settledAccount.quota?.five_hour?.checkedAt
          : undefined,
      ).toBe(fallbackCheckedAt)
      expect(fallbackAtPersistenceReject).toBeUndefined()
      if (!settledAccount || !isOAuthAccount(settledAccount))
        throw new Error('Settled OAuth account is missing')
      // Route completion may display the replacement's verified quota. The
      // refused old response must not supply its quota to that display.
      expect(sidebarStates).not.toContainEqual(
        expect.objectContaining({
          fallbacks: expect.arrayContaining([
            expect.objectContaining({
              id: 'fallback-1',
              quota: expect.objectContaining({
                five_hour: expect.objectContaining({ usedPercent: 4 }),
              }),
            }),
          ]),
        }),
      )
      expect(settledAccount?.quota?.five_hour?.usedPercent).toBe(60)
      expect(settledAccount?.quota?.seven_day?.usedPercent).toBe(70)
      expect(await readFeedEntries()).toEqual([])
    } finally {
      responseGate.open()
      await Promise.allSettled([responsePromise, fallbackResponse])
      await drainSidebarWrites()
      __setLogTestSink(null)
      __setSidebarStateWriteTestHooks(null)
      setLogLevel('info')
    }
  })

  test('main-route sidebar writes use current fallback storage after re-login', async () => {
    const fallbackCheckedAt = Date.now()
    const fallbackAccess = 'sk-ant-oat01-sidebar-fallback-a'
    const responseGate = bodyLifetime().gate()
    const startedGate = bodyLifetime().gate()
    let mainValue = new Response('{}', { status: 503 })
    const mainResponse = responseGate.wait.then(() => mainValue)
    const releaseMainResponse = (response: Response) => {
      mainValue = response
      responseGate.open()
    }
    const mainStarted = () => startedGate.open()
    const mainRequestStarted = startedGate.wait
    let responsePromise: Promise<Response> | undefined
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: {
              source: 'poll',
              checkedAt: fallbackCheckedAt,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: fallbackCheckedAt,
              },
              seven_day: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: fallbackCheckedAt,
              },
            },
            mainQuotaCheckedAt: fallbackCheckedAt,
          },
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: fallbackAccess,
              refresh: 'fallback-lineage-a-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              authLineageId: 'lineage-a',
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: fallbackCheckedAt,
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: fallbackCheckedAt,
                },
              },
            },
          ],
        }),
      ),
    )
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/messages')) {
            const token = new Headers(init?.headers).get('authorization')
            if (token === 'Bearer sk-ant-oat01-main-access') {
              mainStarted?.()
              return mainResponse
            }
            return Promise.resolve(new Response(null, { status: 429 }))
          }
          return Promise.resolve(Response.json({}))
        },
      ),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      await drainSidebarWrites()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const quotaManager = getPluginTestHandles(plugin).quotaManager
      responsePromise = Promise.resolve(
        result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
        }),
      )
      bodyLifetime().trackDetached(responsePromise)
      await Promise.race([
        mainRequestStarted,
        responsePromise.then(() => {
          throw new Error('Request completed without reaching main')
        }),
      ])
      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBe(25)
      if (!testContext.migratedPool) throw new Error('Missing migrated pool')
      const replacementRuntime = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      try {
        const replacementAccess = 'sk-ant-oat01-sidebar-fallback-b'
        loginIssues(fallbackAccess, replacementAccess)
        await replacementRuntime.loginOAuth({
          routeId: 'fallback-1',
          replace: true,
          accountIdentity: syntheticFallbackAccountUuid(0),
          credential: {
            access: replacementAccess,
            refresh: 'fallback-lineage-b-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
        })
      } finally {
        replacementRuntime.close()
      }
      releaseMainResponse?.(new Response('{}', { status: 200 }))

      const response = await responsePromise
      expect(response.status).toBe(200)
      await response.text()

      await getPluginTestHandles(plugin).drainSidebarRouteWrites()
      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBeUndefined()
      await drainSidebarWrites()
    } finally {
      responseGate.open()
      await Promise.allSettled([responsePromise, mainResponse])
      await drainSidebarWrites()
      setLogLevel('info')
    }
  })

  test('does not hold a model response on the display-only sidebar write', async () => {
    await useTempAccountFile(
      createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
    )
    let responseStarted!: () => void
    const responseStartedPromise = new Promise<void>((resolve) => {
      responseStarted = resolve
    })
    let sidebarWriteStarted!: () => void
    const sidebarWriteStartedPromise = new Promise<void>((resolve) => {
      sidebarWriteStarted = resolve
    })
    let releaseSidebarWrite!: () => void
    const sidebarWriteRelease = new Promise<void>((resolve) => {
      releaseSidebarWrite = resolve
    })
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/v1/messages')) {
          responseStarted()
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        return Promise.resolve(Response.json({}))
      }),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks({
        beforeRename: async () => {
          sidebarWriteStarted()
          await sidebarWriteRelease
        },
      })

      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      await responseStartedPromise
      await sidebarWriteStartedPromise
      const settledBeforeRelease = await Promise.race([
        responsePromise.then(() => true),
        Bun.sleep(50).then(() => false),
      ])
      expect(settledBeforeRelease).toBe(true)

      releaseSidebarWrite()
      expect((await responsePromise).status).toBe(200)
    } finally {
      releaseSidebarWrite?.()
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks(null)
    }
  })

  test('cross-account reload cannot retime a published main observation', async () => {
    const originalNow = Date.now
    const requestCheckedAt = 1_000_000
    Date.now = () => requestCheckedAt
    try {
      const accountIdentity = syntheticMainAccountUuid
      const accessToken = 'sk-ant-oat01-cross-account-timestamp'
      const otherCheckedAt = 2_000_000
      const storage = bindMainQuotaToAccount(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          quotaHeaderFeed: { enabled: true },
          accounts: [],
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: {
              source: 'headers',
              checkedAt: requestCheckedAt,
              five_hour: {
                usedPercent: 4,
                remainingPercent: 96,
                checkedAt: requestCheckedAt,
              },
              seven_day: {
                usedPercent: 52,
                remainingPercent: 48,
                checkedAt: requestCheckedAt,
              },
            },
            mainQuotaCheckedAt: otherCheckedAt,
          },
        }),
        accessToken,
        accountIdentity,
      )
      await useTempAccountFile(storage, {
        access: accessToken,
        refresh: 'main-refresh',
        expires: requestCheckedAt + 8 * 60 * 60_000,
      })
      // Migration orders quota by the account-bound snapshot, not the unrelated
      // standalone clock. The runtime projection must retain that ordering.
      const mixedState = await readAccountStorage()
      expect(mixedState?.quota?.mainQuota?.accountIdentity).toBe(
        accountIdentity,
      )
      expect(mixedState?.quota?.mainQuotaCheckedAt).toBe(requestCheckedAt)
      globalThis.fetch = Object.assign(
        mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const admitted = await nativeAdmissionAnswer(input, init)
          if (admitted) return admitted
          if (extractUrl(input).includes('/v1/messages'))
            return new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.04',
                'anthropic-ratelimit-unified-7d-utilization': '0.52',
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
            access: accessToken,
            refresh: 'main-refresh',
            expires: requestCheckedAt + 8 * 60 * 60_000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(response.status).toBe(200)
      await response.text()
      const entries = await waitForFeedEntries(
        (entries) => entries.length === 1,
        'one account-bound header observation',
      )
      expect(entries[0]).toMatchObject({
        account_ref: accountIdentity,
        anthropic_account_uuid: accountIdentity,
        observed_at_ms: requestCheckedAt,
      })
      expect(entries[0]).not.toMatchObject({ observed_at_ms: otherCheckedAt })
    } finally {
      Date.now = originalNow
    }
  })

  test('withholds the main feed entry when bootstrap cannot identify the account', async () => {
    let modelCalls = 0
    let bootstrapCalls = 0
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId: 'unknown-main',
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
      {
        access: 'sk-ant-oat01-unknown-feed',
        refresh: 'unknown-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
    )
    globalThis.fetch = Object.assign(
      mock((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token'))
          return Promise.resolve(
            Response.json({
              access_token: 'sk-ant-oat01-unknown-feed-successor',
              refresh_token: 'unknown-refresh-successor',
              expires_in: 28800,
            }),
          )
        if (url.includes('/claude_cli/bootstrap')) bootstrapCalls++
        if (url.includes('/v1/messages')) {
          modelCalls++
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
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
          access: 'sk-ant-oat01-unknown-feed',
          refresh: 'unknown-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await expect(result.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
      'Claude OAuth refresh is backed off',
    )
    expect(bootstrapCalls).toBeGreaterThan(0)
    expect(modelCalls).toBe(0)
    expect(await readFeedEntries()).toEqual([])
  })

  test('coalesces concurrent main identity resolution for the same token', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('compat-main-access')
  })

  test('aborts a request whose main identity becomes stale during resolution', async () => {
    // OAuth records without Anthropic's access-token prefix are no longer served natively: the request is
    // refused with guidance and nothing reaches the model or the quota feed.
    await expectNonOatMainRefused('compat-a')
  })
})

describe('main identity boot order', () => {
  afterEach(() => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  })

  test('publishes main identity before background timers observe storage and preserves it across native token rotation', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
      ),
      { ...syntheticMainHostAuth(), expires: Date.now() + 8 * 60 * 60_000 },
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const timerCallbacks: (() => void)[] = []
    const observedIds: (string | undefined)[] = []
    const timerObservedIds: (string | undefined)[] = []
    let authCalls = 0
    const auth = () => {
      authCalls += 1
      if (authCalls > 1) {
        bodyLifetime().trackDetached(
          readAccountStorage().then((storage) =>
            observedIds.push(storage?.mainAccountId),
          ),
        )
      }
      return Promise.resolve(custodyTombstoneOAuth('anthropic'))
    }
    const plugin = await getPlugin(undefined, undefined, {
      setInterval: ((callback: () => void) => {
        if (!testContext.migratedPool)
          throw new Error('Missing native main fixture')
        const runtime = JSON.parse(
          readFileSync(testContext.migratedPool.paths.runtime, 'utf8'),
        ) as {
          accounts: Record<
            string,
            { binding: { kind: string; rowId: string; identity?: string } }
          >
        }
        timerObservedIds.push(
          Object.values(runtime.accounts).find(
            (entry) => entry.binding.kind === 'local',
          )?.binding.identity,
        )
        timerCallbacks.push(callback)
        return { unref() {} } as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    })
    await plugin.auth.loader(auth, { models: {} })
    const first = (await readAccountStorage())?.mainAccountId
    if (!first || !testContext.migratedPool)
      throw new Error('Missing native main identity')
    const runtime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
      local: {
        refreshToken: async () => ({
          access: 'sk-ant-oat01-main-boot-rotated',
          refresh: 'main-boot-rotated-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
          expiresIn: 8 * 60 * 60,
        }),
        resolveIdentity: async () =>
          getClaudeCodeIdentityForVerifiedAccount(
            'main',
            poolMainIdentity() as ProviderAccountUuid,
          ),
      },
    })
    try {
      const rotated = await runtime.authorizeLocal('main', {
        intent: 'refresh',
      })
      if (rotated.status !== 'usable')
        throw new Error(
          `Native main rotation failed: ${rotated.status} ${'failure' in rotated ? JSON.stringify(rotated.failure) : 'reason' in rotated ? rotated.reason : ''}`,
        )
      expect(rotated.status).toBe('usable')
      expect(rotated.access).toBe('sk-ant-oat01-main-boot-rotated')
    } finally {
      runtime.close()
    }
    const mainLogin = testContext.poolLogins[0]
    if (!mainLogin) throw new Error('Missing main mock account')
    mainLogin.access = 'sk-ant-oat01-main-boot-rotated'
    mainLogin.refresh = 'main-boot-rotated-refresh'
    await plugin.auth.loader(auth, { models: {} })
    await Promise.all(
      timerCallbacks.map((callback) => Promise.resolve(callback())),
    )
    const second = (await readAccountStorage())?.mainAccountId

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).toBe(first)
    expect(timerObservedIds.length).toBeGreaterThan(0)
    expect(timerObservedIds.every((identity) => identity === first)).toBe(true)
    expect(observedIds).toContain(first)
  })
})

describe('quota header feed extended integration', () => {
  const originalFetch = globalThis.fetch

  afterEach(async () => {
    await drainBeforeReset(testContext.testLifetime, () => {
      globalThis.fetch = originalFetch
    })
  })

  test(
    'drains a deferred model request before restoring its fetch stub',
    deferModelRequestUntilTeardown,
  )

  test('disabled quota header feed publishes nothing by default or when explicitly false', async () => {
    for (const enabled of [undefined, false]) {
      const storage = createFallbackStorage({
        quotaHeaderFeed: enabled === undefined ? undefined : { enabled },
        accounts: [],
      })
      const { response } = await loadMainAndFetch(
        storage,
        new Response('{}', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
        }),
      )
      expect(await response.text()).toBe('{}')
      expect(await readFeedEntries()).toEqual([])
    }
  })

  test('feed publication failure does not affect response, quota persistence, or sidebar update', async () => {
    const feedDirectory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
    await useTempAccountFile(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        accounts: [],
        quota: { enabled: false },
      }),
    )
    const feedParentFile = join(dirname(feedDirectory), 'feed-parent-file')
    await Bun.write(feedParentFile, 'not a directory')
    process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
      feedParentFile,
      'quota-header-feed',
    )
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
          }),
        ),
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
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    })
    expect(await response.text()).toBe('{"ok":true}')
    const persisted = await waitForAccountStorage((storage) =>
      Boolean(storage?.quota?.mainQuota?.five_hour),
    )
    expect(persisted?.quota?.mainQuota?.five_hour?.usedPercent).toBe(25)
    expect(persisted?.quota?.mainQuota?.accountIdentity).toBe(
      persisted?.mainAccountId,
    )
    const sidebar = await waitForSidebarState(
      (state) => state.main.quota?.five_hour?.usedPercent === 25,
    )
    expect(sidebar.main.quota?.five_hour?.usedPercent).toBe(25)
    expect(await readFeedEntries()).toEqual([])
  })

  test('sidebar quota refresh preserves rotated account metadata without acquiring credentials', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        main: { type: 'opencode', provider: 'anthropic' },
      }),
      {
        access: 'sk-ant-oat01-main-access-before-rotation',
        refresh: 'main-refresh',
        expires: Date.now() + 100_000,
      },
    )
    const currentAccess = 'sk-ant-oat01-main-access-before-rotation'
    const fetchSpy = mock(
      withNativeTokenExchange((input: unknown, init?: RequestInit) => {
        const url = extractUrl(input as string | URL | Request)
        if (url.startsWith(MESSAGES_URL)) {
          return Promise.resolve(
            new Response('{}', {
              status: 200,
              headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
            }),
          )
        }
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({
              oauth_account: {
                account_uuid: '44444444-4444-4444-4444-444444444444',
              },
            }),
          )
        }
        return Promise.reject(new Error(`Unexpected test fetch: ${url}`))
      }),
    )
    globalThis.fetch = Object.assign(fetchSpy, {
      preconnect: globalThis.fetch.preconnect,
    })
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: currentAccess,
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    // Another OpenCode process refreshes the main login; the pool now holds
    // the rotated access token for the same account.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-main-access-after-rotation',
      refresh: 'main-refresh-after-rotation',
      expires: Date.now() + 100_000,
    })

    const pool = testContext.migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    bodyLifetime().deferCleanup(() => reader.close())
    expect(
      (await reader.captureLocalSubject('main')).version?.accessFingerprint,
    ).toBe(tokenFingerprint('sk-ant-oat01-main-access-after-rotation'))
    await waitForAccountStorage(
      (storage) => storage?.quota?.mainQuota?.five_hour?.usedPercent === 25,
    )
    const requestsBeforeDisplay = fetchSpy.mock.calls.length
    const resolved =
      await getPluginTestHandles(plugin).resolveSidebarQuotaAccess()
    expect(resolved.access).toBeUndefined()
    expect(resolved.storage?.quota?.mainQuota?.accountIdentity).toBe(
      '44444444-4444-4444-4444-444444444444',
    )
    expect(resolved.storage?.quota?.mainQuota?.five_hour?.usedPercent).toBe(25)
    expect(fetchSpy.mock.calls.length).toBe(requestsBeforeDisplay)
    await plugin.dispose?.()
  })

  test('deduplicates main feed observations across access-token rotation', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId: 'stable-main-account',
        quotaHeaderFeed: { enabled: true },
        accounts: [],
        quota: { enabled: false },
      }),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: 'main-refresh',
        expires: Date.now() + 100000,
      },
    )
    let requestCount = 0
    globalThis.fetch = mock(
      withNativeAdmission(() => {
        requestCount += 1
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': String(
                requestCount / 100,
              ),
            },
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()

    for (const access of [
      'sk-ant-oat01-main-access-a',
      'sk-ant-oat01-main-access-b',
    ]) {
      // The second generation is a refresh of the same account in another
      // OpenCode process, which rotates the pool's main access token.
      if (access !== 'sk-ant-oat01-main-access-a')
        await refreshPoolMainElsewhere({
          access,
          refresh: `main-refresh-${access}`,
          expires: Date.now() + 100000,
        })
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access-a',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await response.text()
    }

    const entries = await waitForFeedEntries(
      (candidate) => candidate.length === 1,
      'one published entry',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(
      // Quota uses Anthropic's account UUID, not the local identifier used
      // to keep the main login's device identity stable across token rotation.
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: poolMainIdentity(),
      }),
    )
  })

  test('ordered fallback admission sends an unknown-quota OAuth account', async () => {
    await useTempAccountFile(
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
            expires: Date.now() + 5 * 60 * 60_000,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.reject(new Error('quota source unavailable'))
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
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
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(authorizations).toContain(
      'Bearer sk-ant-oat01-unknown-fallback-access',
    )
  })

  test('ordered fallback admission rejects unknown-quota OAuth under fail-closed', async () => {
    await expectUnknownQuotaAdmissionBlocked(
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
    )
  })

  test('ordered fallback admission excludes an active refresh-backoff account while admitting an identical account without backoff', async () => {
    const now = Date.now()
    for (const lastRefreshError of [
      {
        message: 'refresh temporarily unavailable',
        checkedAt: now,
        nextRetryAt: now + 60_000,
        retryCount: 1,
        accountIdentity: 'unknown-fallback',
        permanent: false,
        // Old anthropic-auth-state.json errors carry a refresh-token hash.
        // Migration preserves the matching credential's retry restriction.
        tokenHash: hashRefreshToken('unknown-fallback-refresh'),
      },
      undefined,
    ]) {
      const storage = bindPoolAccounts(
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
              expires: now + 1_000,
              lastRefreshError,
            },
          ],
        }),
      )
      await useTempAccountFile(storage)
      loginIssues(
        'sk-ant-oat01-unknown-fallback-access',
        'sk-ant-oat01-refreshed-fallback-access',
      )
      const messageAuthorizations: string[] = []
      globalThis.fetch = mock(
        withNativeBootstrap((input: any, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/oauth/token'))
            return Promise.resolve(
              Response.json({
                access_token: 'sk-ant-oat01-refreshed-fallback-access',
                expires_in: 18_000,
              }),
            )
          if (url.includes('/api/oauth/usage'))
            return Promise.reject(new Error('quota source unavailable'))
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
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      if (lastRefreshError) {
        expect(messageAuthorizations).not.toContain(
          'Bearer sk-ant-oat01-unknown-fallback-access',
        )
      } else {
        expect(response.status).toBe(200)
        expect(messageAuthorizations.length).toBeGreaterThan(0)
        // The original bearer is still valid, so dispatch need not wait for
        // proactive rotation. Both bearers belong to the admitted fallback.
        for (const authorization of messageAuthorizations)
          expect([
            'Bearer sk-ant-oat01-unknown-fallback-access',
            'Bearer sk-ant-oat01-refreshed-fallback-access',
          ]).toContain(authorization)
      }
    }
  })

  test('ordered fallback admission rejects unknown-quota OAuth with refresh backoff under fail-closed', async () => {
    const now = Date.now()
    await expectUnknownQuotaAdmissionBlocked(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires: now + 5 * 60 * 60_000,
            lastRefreshError: {
              message: 'refresh temporarily unavailable',
              checkedAt: now,
              nextRetryAt: now + 60_000,
              retryCount: 1,
              accountIdentity: 'unknown-fallback',
              permanent: false,
            },
          },
        ],
      }),
    )
  })

  test('fail-closed quota backoff gate blocks send when main quota is unknown', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.reject(new Error('quota source unavailable'))
        if (url.includes('/v1/messages')) messageRequests.push(url)
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
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(429)
    expect(messageRequests).toEqual([])
  })

  test('fail-closed quota gate sends when failClosedOnUnknownQuota is disabled', async () => {
    const now = Date.now()
    const storage = createFallbackStorage({
      accounts: [],
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
        failClosedOnUnknownQuota: false,
        mainLastQuotaApiError: {
          message: 'quota source unavailable',
          checkedAt: now,
          nextRetryAt: now + 60_000,
          retryCount: 1,
        },
      },
    })
    await useTempAccountFile(storage)
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.reject(new Error('quota source unavailable'))
        if (url.includes('/v1/messages')) messageRequests.push(url)
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
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(messageRequests).toHaveLength(1)
    expect(messageRequests[0]).toContain(MESSAGES_URL)
  })

  test('fail-closed quota gate sends when main quota is unknown without quota backoff', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) messageRequests.push(url)
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
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(messageRequests).toHaveLength(1)
    expect(messageRequests[0]).toContain(MESSAGES_URL)
  })

  test('selects account_ref for main and fallback without leaking credential_id', async () => {
    const main = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
      }),
    )
    await main.response.text()
    const mainEntries = await waitForFeedEntries(
      (entries) => entries.length === 1,
      'one main published entry',
    )
    const mainAccountId = (await readAccountStorage())?.mainAccountId
    expect(mainEntries[0]).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: mainAccountId,
      }),
    )
    expect(mainEntries[0]).not.toHaveProperty('credential_id')

    const fallback = await loadMainAndFetch(
      bindPoolAccounts(
        createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          routing: { mode: 'fallback-first' },
        }),
      ),
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
      }),
    )
    await fallback.response.text()
    const fallbackEntry = (
      await waitForFeedEntries(
        (entries) =>
          entries.length === 1 &&
          entries.some((entry: any) => entry.account_ref === 'fallback-1'),
        'one fallback-1 published entry',
      )
    ).find((entry: any) => entry.identity_source === 'account_ref') as any
    expect(fallbackEntry).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: 'fallback-1',
      }),
    )
    expect(fallbackEntry).not.toHaveProperty('credential_id')
  })

  test('published configured account count uses live main OAuth plus every OAuth fallback and excludes API keys', async () => {
    const { response } = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        accounts: [
          {
            id: 'disabled-oauth',
            type: 'oauth',
            access: 'sk-ant-oat01-disabled-access',
            refresh: 'disabled-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
            enabled: false,
          },
          {
            id: 'enabled-oauth',
            type: 'oauth',
            access: 'sk-ant-oat01-enabled-access',
            refresh: 'enabled-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
            enabled: true,
          },
          {
            id: 'api-key',
            type: 'api',
            apiKey: 'key',
            baseURL: 'https://example.test',
          },
        ] as AccountStorage['accounts'],
      }),
      new Response('{}', {
        status: 200,
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
      }),
    )
    expect(response.status).toBe(200)
    await response.text()
    const entries = await waitForFeedEntries(
      (candidate) => candidate.length === 1,
      'one configured-account-count entry',
    )
    expect(entries[0]).toEqual(
      expect.objectContaining({ configured_account_count: 3 }),
    )
  })

  test('publishes genuine relay response headers through onResponseHeaders', async () => {
    const { response } = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          transport: 'http',
        },
      }),
      () =>
        new Response('{}', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.5',
            'x-cortexkit-relay-optimistic': 'true',
          },
        }),
      { 'x-session-affinity': 'feed-relay-session' },
    )
    await response.text()
    const entries = await waitForFeedEntries(
      (candidate) => candidate.length === 1,
      'one relay published entry',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(
      expect.objectContaining({
        quota: expect.objectContaining({
          five_hour: expect.objectContaining({ usedPercent: 50 }),
        }),
      }),
    )
  })
})
