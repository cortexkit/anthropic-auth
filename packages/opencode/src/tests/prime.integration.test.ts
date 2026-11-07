import { afterEach, describe, expect, mock } from 'bun:test'
import { join } from 'node:path'
import type { PrimeManager } from '@cortexkit/anthropic-auth-core'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  type AccountStorage,
  buildPrimeRequestBody,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  createNativePoolStore,
  extractBillingHeaderCCH,
  getClaudeCodeIdentityForVerifiedAccount,
  hashRefreshToken,
  type LogTestRecord,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { rewriteRequestBody } from '../transform.ts'
import { getPluginTestHandles } from './plugin-test-handles'
import {
  applyMenuAction as applyMenuActionWithCtx,
  type createMockClient,
} from './support/opencode1-client.ts'
import {
  bindMainAccount,
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  expectHostActivationNonSecret as expectHostActivationNonSecretWithCtx,
  getPlugin as getPluginWithCtx,
  loginIssues as loginIssuesWithCtx,
  mainAccountIssues as mainAccountIssuesWithCtx,
  poolMainAccess as poolMainAccessWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  refreshPoolLoginElsewhere as refreshPoolLoginElsewhereWithCtx,
  refreshPoolMainElsewhere as refreshPoolMainElsewhereWithCtx,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
  withNativeBootstrap as withNativeBootstrapWithCtx,
} from './support/opencode1-pool-fixture.ts'
import { readAccountStorage as readAccountStorageWithCtx } from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  getBodyLifetime,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)
const primeMarkerRoots = new WeakMap<TestLifetime, string>()

function bodyLifetime(): TestLifetime {
  return getBodyLifetime(testContext)
}
// Repeated synthetic UUIDs must not share claims with other test bodies.
// Plugins within one body keep a shared root, including across account files.
async function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth: {
    access: string
    refresh: string
    expires: number
  } = syntheticMainHostAuth(),
) {
  await useTempAccountFileWithCtx(testContext, storage, mainHostAuth)
  const lifetime = bodyLifetime()
  if (!primeMarkerRoots.has(lifetime)) {
    primeMarkerRoots.set(
      lifetime,
      join(testContext.tempConfigDir!, 'prime-markers'),
    )
  }
}
function mainAccountIssues(...accesses: string[]) {
  return mainAccountIssuesWithCtx(testContext, ...accesses)
}
function loginIssues(current: string, ...accesses: string[]) {
  return loginIssuesWithCtx(testContext, current, ...accesses)
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
function expectHostActivationNonSecret(...tokens: string[]) {
  return expectHostActivationNonSecretWithCtx(testContext, ...tokens)
}
function poolMainAccess(): Promise<string> {
  return poolMainAccessWithCtx(testContext)
}
function readNativeRuntimeState() {
  return readNativeRuntimeStateWithCtx(testContext)
}
async function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): Promise<any> {
  const plugin = await getPluginWithCtx(
    testContext,
    client,
    directory,
    runtimeOverrides,
  )
  const manager = getPluginTestHandles(plugin).primeManager
  manager.updateOptions({
    ...manager.options,
    markerDir: primeMarkerRoots.get(bodyLifetime()),
  })
  return plugin
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
async function assertPrimeWithPublicDiagnostics(
  manager: PrimeManager,
  requestStages: readonly string[],
  assertion: () => void,
): Promise<void> {
  try {
    assertion()
  } catch (error) {
    // Record only request stages and public status. A diagnostic read failure
    // must not replace the original assertion or expose exception text.
    let status: ReturnType<PrimeManager['stats']> | 'unavailable'
    try {
      status = manager.stats(await readAccountStorage())
    } catch {
      status = 'unavailable'
    }
    console.error(
      JSON.stringify({ primeAssertionFailure: { requestStages, status } }),
    )
    throw error
  }
}
async function freshPrimeQuotaResponse(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Promise<Response> {
  await Bun.sleep(2)
  return new Response(JSON.stringify(body), init)
}

// -- /claude-prime: direct OAuth sender + quota refresh + accounting ------

describe('claude-prime direct request', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('main prime fires a direct messages request with the documented body shape', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    const primeCalls: Array<{
      url: string
      init: RequestInit | undefined
    }> = []
    let quotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url, init })
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 'msg-test',
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          quotaCalls += 1
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    // Reach into the plugin's internal manager via the auth closure wiring
    // already in place: the manager has been constructed with sendPrime wired
    // to a closure that calls the auth loader. Trigger an explicit tick via
    // the manager factory on `plugin`.
    const mgr = getPluginTestHandles(plugin).primeManager
    expect(mgr).toBeDefined()
    await mgr!.tick()

    expect(primeCalls).toHaveLength(1)
    // The prime request routes through rewriteUrl which appends
    // ?beta=true to /v1/messages URLs (house convention for direct
    // Anthropic calls). Assert the URL is the messages endpoint with
    // the beta param rather than the bare path.
    expect(primeCalls[0]?.url).toBe(`${MESSAGES_URL}?beta=true`)
    const init = primeCalls[0]?.init
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : ''
    const body = JSON.parse(bodyText)
    const canonicalBody = await rewriteRequestBody(
      JSON.stringify(buildPrimeRequestBody()),
      {
        identity: getClaudeCodeIdentityForVerifiedAccount(
          syntheticMainAccountUuid,
          syntheticMainAccountUuid,
        ),
      },
    )
    expect(bodyText).toBe(canonicalBody)
    expect(body.model).toBe('claude-haiku-4-5')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: '0' }])
    expect(JSON.stringify(body.system)).toContain(
      'Reply with 1 when you receive 0.',
    )
    expect(extractBillingHeaderCCH(bodyText)).toMatch(/^[a-f0-9]{5}$/)
    expect(body.stream).toBeUndefined()
    expect(body.thinking).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(bodyText).not.toContain('cache_control')

    // Quota fresh-check fired before the request
    expect(quotaCalls).toBeGreaterThanOrEqual(1)
  })

  test('main prime uses main OAuth token + Anthropic identity headers', async () => {
    const requestStages: string[] = []
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let observedAuth: string | undefined
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          requestStages.push(
            url.includes('/api/oauth/usage')
              ? 'quota'
              : url.includes('/v1/messages')
                ? 'model'
                : 'other',
          )
          if (url.includes('/v1/messages')) {
            const headers = new Headers(init?.headers ?? {})
            observedAuth = headers.get('authorization') ?? undefined
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  usage: { input_tokens: 20, output_tokens: 1 },
                }),
                {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            )
          }
          if (url.includes('/api/oauth/usage')) {
            return freshPrimeQuotaResponse({
              five_hour: {
                utilization: 0,
                resets_at: new Date(now - 1_000).toISOString(),
              },
            })
          }
          return Promise.resolve(new Response('not-mocked', { status: 599 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    if (!(mgr instanceof Core.PrimeManager))
      throw new Error('Expected the native Prime manager')
    expect(await mgr.options.getAccountIdentity?.('main')).toBe(
      syntheticMainAccountUuid,
    )
    await mgr.tick()

    await assertPrimeWithPublicDiagnostics(mgr, requestStages, () => {
      expect(observedAuth).toBeDefined()
      expect(observedAuth).toContain('sk-ant-oat01-main-access')
    })
  })

  test('main host credential replacement keeps the stable lineage in the same reset window', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
        'sk-ant-oat01-main-access-a',
      ),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: 'main-refresh-a',
        expires: Date.now() + 100000,
      },
    )

    let sends = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          sends += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const firstPlugin = await getPlugin()
    await firstPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: 'main-refresh-a',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await getPluginTestHandles(firstPlugin).primeManager.tick()
    const firstLineage = (await readAccountStorage())?.prime?.mainAuthLineageId

    // The main login's tokens rotate for the same account (a refresh in
    // another OpenCode process); a second plugin instance then starts.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-main-access-b',
      refresh: 'main-refresh-b',
      expires: Date.now() + 100000,
    })
    const secondPlugin = await getPlugin()
    await secondPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: 'main-refresh-a',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await getPluginTestHandles(secondPlugin).primeManager.tick()

    expect(sends).toBe(1)
    expect(firstLineage).toMatch(/^[0-9a-f-]{36}$/)
    expect((await readAccountStorage())?.prime?.mainAuthLineageId).toBe(
      firstLineage,
    )
  })

  test('main refresh through the plugin keeps the lineage and prime claim', async () => {
    const past = Date.now() - 180_000
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [],
          prime: { enabled: true },
          quota: {
            ...createFallbackStorage().quota,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
          },
        }),
        'sk-ant-oat01-main-access-a',
      ),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: 'main-refresh-a',
        expires: Date.now() + 5 * 60 * 60_000,
      },
    )
    mainAccountIssues('sk-ant-oat01-main-access-b')
    let primeSends = 0
    let tokenExchanges = 0
    const foregroundAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      withNativeBootstrap(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/oauth/token')) {
            tokenExchanges += 1
            return Promise.resolve(
              Response.json({
                access_token: 'sk-ant-oat01-main-access-b',
                refresh_token: 'main-refresh-b',
                expires_in: 5 * 60 * 60,
              }),
            )
          }
          if (url.includes('/api/oauth/usage'))
            return freshPrimeQuotaResponse({
              five_hour: {
                utilization: 0,
                resets_at: new Date(past).toISOString(),
              },
            })
          if (url.includes('/v1/messages')) {
            const body = JSON.parse(String(init?.body))
            if (body.model === 'claude-haiku-4-5' && body.max_tokens === 1) {
              primeSends += 1
              return Promise.resolve(
                Response.json({
                  usage: { input_tokens: 20, output_tokens: 1 },
                }),
              )
            }
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            foregroundAuthorizations.push(authorization)
            return Promise.resolve(
              new Response('{}', {
                status:
                  authorization === 'Bearer sk-ant-oat01-main-access-a'
                    ? 401
                    : 200,
              }),
            )
          }
          throw new Error(`Unexpected test endpoint: ${url}`)
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: 'main-refresh-a',
          expires: Date.now() + 5 * 60 * 60_000,
        }),
      { models: {} },
    )
    const manager = getPluginTestHandles(plugin).primeManager
    await manager.tick()
    const before = (await readAccountStorage())?.prime?.mainAuthLineageId
    expect(before).toMatch(/^[0-9a-f-]{36}$/)
    expect(tokenExchanges).toBe(0)
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(response.status).toBe(200)
    expect(tokenExchanges).toBe(1)
    expect(foregroundAuthorizations).toEqual([
      'Bearer sk-ant-oat01-main-access-a',
      'Bearer sk-ant-oat01-main-access-b',
    ])
    expect(await poolMainAccess()).toBe('sk-ant-oat01-main-access-b')
    await manager.tick()
    expect(primeSends).toBe(1)
    expect((await readAccountStorage())?.prime?.mainAuthLineageId).toBe(before)
    await expectHostActivationNonSecret(
      'sk-ant-oat01-main-access-a',
      'sk-ant-oat01-main-access-b',
      'main-refresh-a',
      'main-refresh-b',
    )
  })

  test('a late main 401 adopts externally rotated credentials and preserves the imported Prime lineage', async () => {
    const lineage = 'main-lineage-a'
    const refreshToken = 'main-refresh-a'
    await useTempAccountFile(
      bindMainAccount(
        createFallbackStorage({
          accounts: [],
          quota: { ...createFallbackStorage().quota, enabled: false },
          refresh: {
            enabled: true,
            refreshBeforeExpiryMinutes: 30,
            mainRefreshLeaseId: 'other-process',
            mainRefreshLeaseUntil: Date.now() + 60_000,
            mainRefreshLeaseTokenHash: hashRefreshToken(refreshToken),
          },
          prime: {
            enabled: true,
            mainAuthLineageId: lineage,
            mainAuthLineageRefreshTokenFingerprint:
              tokenFingerprint(refreshToken),
          },
        }),
        'sk-ant-oat01-main-access-a',
      ),
      {
        access: 'sk-ant-oat01-main-access-a',
        refresh: refreshToken,
        expires: Date.now() + 5 * 60 * 60_000,
      },
    )
    globalThis.fetch = mock(
      withNativeAdmission(() => Response.json({})),
    ) as unknown as typeof fetch
    expect(await poolMainAccess()).toBe('sk-ant-oat01-main-access-a')
    const firstRequest = bodyLifetime().gate()
    const releaseRejectedResponse = bodyLifetime().gate()
    const controller = new AbortController()
    let reachedModel = false
    const authorizations: Array<string | null> = []
    let pluginTokenExchanges = 0
    globalThis.fetch = mock(
      withNativeBootstrap(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/oauth/token')) {
            pluginTokenExchanges += 1
            throw new Error(
              'The plugin must adopt the externally rotated token',
            )
          }
          if (url.includes('/v1/messages')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            if (authorization === 'Bearer sk-ant-oat01-main-access-a') {
              reachedModel = true
              firstRequest.open()
              return releaseRejectedResponse.wait.then(
                () => new Response('{}', { status: 401 }),
              )
            }
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          if (url.includes('/api/oauth/usage'))
            return freshPrimeQuotaResponse({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            })
          throw new Error(`Unexpected test endpoint: ${url}`)
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access-a',
          refresh: refreshToken,
          expires: Date.now() + 5 * 60 * 60_000,
        }),
      { models: {} },
    )
    const request = result.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      signal: controller.signal,
    })
    try {
      await Promise.race([
        firstRequest.wait,
        request.then(() => {
          throw new Error('Request completed before the rejection fixture')
        }),
      ])
      if (!reachedModel)
        throw new Error(
          'Model request did not reach the fixture before cancellation',
        )
      await refreshPoolMainElsewhere({
        access: 'sk-ant-oat01-main-access-b',
        refresh: 'main-refresh-b',
        expires: Date.now() + 5 * 60 * 60_000,
      })
      releaseRejectedResponse.open()
      expect((await request).status).toBe(200)
      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-main-access-a',
        'Bearer sk-ant-oat01-main-access-b',
      ])
      expect(pluginTokenExchanges).toBe(0)
      expect((await readAccountStorage())?.prime?.mainAuthLineageId).toBe(
        lineage,
      )
      await expectHostActivationNonSecret(
        'sk-ant-oat01-main-access-a',
        'sk-ant-oat01-main-access-b',
        refreshToken,
        'main-refresh-b',
      )
    } finally {
      controller.abort()
      releaseRejectedResponse.open()
      await request.catch(() => {})
    }
  })

  test('fallback prime uses fallback OAuth token', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access',
              refresh: 'fb-refresh',
              // expires must exceed the refresh-before-expiry window (4h default)
              // so the token is NOT marked as needing refresh and the prime
              // request flows through without the OAuth refresh fetch.
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: new Date(past).toISOString(),
                  // Recent (1min) so the background refresh's
                  // `isFallbackStale` guard does NOT fire a competing
                  // refresh in the same millisecond — without this the
                  // prime fresh-check's baseline equals the fetched
                  // checkedAt and `fresh` is false. The check-interval
                  // gate is 5min (storage.quota.checkIntervalMinutes),
                  // so a 1min-old checkedAt is comfortably fresh.
                  checkedAt: Date.now() - 60 * 1000,
                },
              },
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
          },
          prime: { enabled: true },
        }),
      ),
    )

    const calls: Array<{ url: string; auth?: string }> = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        const headers = new Headers(init?.headers ?? {})
        calls.push({ url, auth: headers.get('authorization') ?? undefined })
        if (url.includes('/v1/messages')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    await mgr!.tick()

    const primeCall = calls.find(
      (c) =>
        c.url === `${MESSAGES_URL}?beta=true` &&
        c.auth?.includes('sk-ant-oat01-fb-access'),
    )
    expect(primeCall).toBeDefined()
    expect(primeCall?.auth).toContain('sk-ant-oat01-fb-access')
  })

  test('fallback refresh-token rotation keeps one prime claim per reset window', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-rotating',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access-a',
              refresh: 'fb-refresh-a',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              authLineageId: 'lineage-work',
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: new Date(past).toISOString(),
                  checkedAt: Date.now() - 60 * 1000,
                },
              },
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
          },
          prime: { enabled: true },
        }),
      ),
    )

    let sends = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          const authorization = new Headers(init?.headers).get('authorization')
          if (authorization?.includes('fb-access-')) sends += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager

    await mgr!.tick()
    // Another process refreshes the fallback; its refresh token rotates.
    loginIssues('sk-ant-oat01-fb-access-a', 'sk-ant-oat01-fb-access-b')
    await refreshPoolLoginElsewhere('work-rotating', {
      access: 'sk-ant-oat01-fb-access-b',
      refresh: 'fb-refresh-b',
      expires: Date.now() + 5 * 60 * 60 * 1000,
    })
    await mgr!.tick()

    expect(sends).toBe(1)
  })

  test('send failure does not increment prime counters; no retry in same cycle', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let messageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          messageCalls += 1
          return Promise.resolve(new Response('boom', { status: 500 }))
        }
        if (url.includes('/api/oauth/usage')) {
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    await mgr!.tick()
    await mgr!.tick()

    // Two ticks in the same reset cycle: marker claimed → second tick skips
    expect(messageCalls).toBe(1)

    // No counter incremented (the main account records no prime usage)
    const raw = await readNativeRuntimeState()
    expect(raw.main?.prime).toBeUndefined()
  })

  test('successful send increments main prime counters', async () => {
    const requestStages: string[] = []
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          requestStages.push('model')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          requestStages.push('quota')
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(now - 1_000).toISOString(),
            },
          })
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    if (!(mgr instanceof Core.PrimeManager))
      throw new Error('Expected the native Prime manager')
    await mgr.tick()

    const raw = await readNativeRuntimeState()
    await assertPrimeWithPublicDiagnostics(mgr, requestStages, () => {
      expect(raw.main?.prime).toEqual({
        count: 1,
        inputTokens: 20,
        outputTokens: 1,
        since: expect.any(Number),
      })
    })
  })

  test('main prime refreshes a missing access token before firing (M2)', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 1,
              },
            },
            mainQuotaCheckedAt: 1,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
        'sk-ant-oat01-expired-main-access',
      ),
      // The pool's main access token has expired, so it has no usable
      // access token until it refreshes.
      {
        access: 'sk-ant-oat01-expired-main-access',
        refresh: 'main-refresh',
        expires: Date.now() - 1_000,
      },
    )
    mainAccountIssues('sk-ant-oat01-refreshed-main-access')

    const primeCalls: Array<{ url: string; init: RequestInit | undefined }> = []
    let _quotaCalls = 0
    globalThis.fetch = mock(
      withNativeBootstrap((input: any, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.url
        const _headers = new Headers(init?.headers ?? {})
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url, init })
          return Promise.resolve(
            new Response(
              JSON.stringify({
                usage: { input_tokens: 20, output_tokens: 1 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          _quotaCalls += 1
          return freshPrimeQuotaResponse({
            five_hour: {
              utilization: 0,
              resets_at: new Date(Date.now() - 1_000).toISOString(),
            },
          })
        }
        if (url.includes('/v1/oauth/token')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: 'sk-ant-oat01-refreshed-main-access',
                refresh_token: 'main-refresh',
                expires_in: 3600,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-expired-main-access',
          refresh: 'main-refresh',
          expires: Date.now() - 1_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    expect(mgr).toBeDefined()
    await mgr!.tick()

    // The prime request should have fired with the refreshed token.
    expect(primeCalls).toHaveLength(1)
    const init = primeCalls[0]?.init
    const headers = new Headers(init?.headers ?? {})
    expect(headers.get('authorization')).toContain(
      'sk-ant-oat01-refreshed-main-access',
    )
  })

  test('plugin instances with the same storage path adopt one prime manager', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: true },
    })
    await useTempAccountFile(fixture)
    const plugin1 = await getPlugin()
    const mgr1 = getPluginTestHandles(plugin1).primeManager
    const firstLoadStorage = mgr1.options.loadStorage
    expect(mgr1).toBeDefined()
    expect(mgr1.isStopped?.()).toBeFalsy()
    const plugin2 = await getPlugin()
    const mgr2 = getPluginTestHandles(plugin2).primeManager
    expect(mgr2).toBeDefined()
    expect(mgr2).toBe(mgr1)
    expect(mgr2.options.loadStorage).not.toBe(firstLoadStorage)
    expect(mgr1.isStopped()).toBe(false)
  })

  test('plugin instances with different storage paths own independent prime managers', async () => {
    const fixture = createFallbackStorage({ prime: { enabled: true } })
    await useTempAccountFile(fixture)
    const plugin1 = await getPlugin(undefined, '/project/one')
    const mgr1 = getPluginTestHandles(plugin1).primeManager

    await useTempAccountFile(fixture)
    const plugin2 = await getPlugin(undefined, '/project/two')
    const mgr2 = getPluginTestHandles(plugin2).primeManager

    expect(mgr2).not.toBe(mgr1)
    expect(mgr1.isStopped()).toBe(false)
    expect(mgr2.isStopped()).toBe(false)
  })
})

describe('claude-prime sidebar on toggle', () => {
  let sidebarStateFile: string | undefined

  async function readSidebar(): Promise<{
    prime?: { enabled?: boolean; accounts?: unknown }
  }> {
    if (!sidebarStateFile) {
      throw new Error('sidebar state file not configured')
    }
    const fs = await import('node:fs/promises')
    try {
      return JSON.parse(await fs.readFile(sidebarStateFile, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Sidebar file has not been written yet — treat as empty
        // (degenerate) state with no `prime` field.
        return {}
      }
      throw error
    }
  }

  test('/claude-prime on publishes prime section to the sidebar (M7)', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: false },
    })
    await useTempAccountFile(fixture)
    sidebarStateFile = process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    const plugin = await getPlugin(undefined, testContext.tempConfigDir)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    // Baseline: prime disabled in storage → no prime section in sidebar.
    const before = await readSidebar()
    expect(before.prime).toBeUndefined()

    expect(
      (
        await applyMenuAction(plugin, 'ses_test', {
          sectionId: 'Extras',
          actionId: 'prime-on',
        })
      ).ok,
    ).toBe(true)

    // After on, sidebar has the prime section.
    const afterOn = await readSidebar()
    expect(afterOn.prime?.enabled).toBe(true)
    expect(afterOn.prime?.accounts).toBeDefined()
  })

  test('/claude-prime off removes prime section from the sidebar (M7)', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: true },
    })
    await useTempAccountFile(fixture)
    sidebarStateFile = process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    const plugin = await getPlugin(undefined, testContext.tempConfigDir)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    // Enable priming and confirm its sidebar row exists before disabling it.
    // Otherwise an absent row after disable could make this test pass vacuously.
    expect(
      (
        await applyMenuAction(plugin, 'ses_test', {
          sectionId: 'Extras',
          actionId: 'prime-on',
        })
      ).ok,
    ).toBe(true)
    const baseline = await readSidebar()
    expect(baseline.prime?.enabled).toBe(true)

    expect(
      (
        await applyMenuAction(plugin, 'ses_test', {
          sectionId: 'Extras',
          actionId: 'prime-off',
        })
      ).ok,
    ).toBe(true)

    // After off, prime section is removed.
    const afterOff = await readSidebar()
    expect(afterOff.prime).toBeUndefined()
  })
})

describe('claude-prime — snapshot-derived freshness (R1/R2)', () => {
  // Before starting an account's five-hour window, PrimeManager must obtain
  // its quota from one current usage request. Cached quota cannot authorize
  // that request, and the fallback quota check must not poll twice.

  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('R1: the manager skips a quota result classified stale', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 10,
              },
            },
            mainQuotaCheckedAt: 10,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    const primeCalls: any[] = []
    const cachedQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(past).toISOString(),
        checkedAt: 10,
      },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url })
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    if (!(mgr instanceof Core.PrimeManager))
      throw new Error('Expected the native Prime manager')
    let freshChecks = 0
    mgr.options.refreshQuota = async () => {
      freshChecks += 1
      return { quota: cachedQuota, fresh: false }
    }
    await mgr.tick()

    expect(freshChecks).toBe(1)
    expect(primeCalls).toHaveLength(0)
  })

  test('R1: the manager fires after a quota result classified fresh', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(past).toISOString(),
                checkedAt: 10,
              },
            },
            mainQuotaCheckedAt: 10,
            mainQuotaToken: 'fp-main',
          },
          prime: { enabled: true },
        }),
      ),
    )

    const primeCalls: Array<{ url: string }> = []
    const freshQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(past).toISOString(),
        checkedAt: 100,
      },
    }

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.includes('/v1/messages')) {
          primeCalls.push({ url })
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    mgr.options.refreshQuota = async () => ({
      quota: freshQuota,
      fresh: true,
    })
    await mgr.tick()

    expect(primeCalls).toHaveLength(1)
  })

  test('R2: refreshPrimeFallbackQuota makes exactly one usage-API call per tick', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access',
              refresh: 'fb-refresh',
              // expires must exceed the 4h refresh-before-expiry window so
              // the token is NOT marked as needing refresh (otherwise the
              // refresh path would make a second fetch to /v1/oauth/token).
              expires: Date.now() + 10 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  resetsAt: new Date(past).toISOString(),
                  // A one-minute-old reading is within the five-minute poll
                  // interval. Startup must not start another usage request;
                  // this test counts only the poll triggered by Prime.
                  checkedAt: Date.now() - 60 * 1000,
                },
              },
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: 'sk-ant-oat01-main-access',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let usageCalls = 0
    let primeCalls = 0
    globalThis.fetch = mock(
      withNativeBootstrap((input: Parameters<typeof fetch>[0]) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          primeCalls += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 20, output_tokens: 1 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          usageCalls += 1
          return freshPrimeQuotaResponse(
            {
              five_hour: {
                utilization: 0,
                resets_at: new Date(Date.now() - 1_000).toISOString(),
                checked_at: Date.now(),
              },
            },
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = getPluginTestHandles(plugin).primeManager
    await mgr.tick()

    // Exactly ONE usage-API call per tick — the redundant second
    // refreshFallback is collapsed into the single refreshAccountQuota
    // path.
    expect(usageCalls).toBe(1)
    // The fire still happens against the (now-fresh) quota result.
    expect(primeCalls).toBe(1)
  })

  test('R1: fallback 429 backoff classifies a re-stamped cached quota as stale', async () => {
    const now = Date.now()
    const past = now - 120_000
    const cachedQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(past).toISOString(),
        checkedAt: now + 60_000,
      },
    }
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'work-alt',
              type: 'oauth',
              access: 'sk-ant-oat01-fb-access',
              refresh: 'fb-refresh',
              expires: now + 10 * 60 * 60_000,
              quota: cachedQuota,
            },
          ],
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                resetsAt: new Date(now + 5 * 60 * 60_000).toISOString(),
                checkedAt: now,
              },
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: 'sk-ant-oat01-main-access',
          },
          prime: { enabled: true },
        }),
      ),
    )

    let primeCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = typeof input === 'string' ? input : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        if (url.includes('/v1/messages')) {
          primeCalls += 1
          return Promise.resolve(
            new Response(
              JSON.stringify({ usage: { input_tokens: 20, output_tokens: 1 } }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('not-mocked', { status: 599 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: now + 3600_000,
        }),
      { models: {} },
    )
    const quotaManager = getPluginTestHandles(plugin).quotaManager
    const mgr = getPluginTestHandles(plugin).primeManager
    if (
      !(quotaManager instanceof Core.QuotaManager) ||
      !(mgr instanceof Core.PrimeManager)
    )
      throw new Error('Expected the native quota and Prime managers')
    const storage = await mgr.options.loadStorage()
    const account = storage?.accounts.find(
      (candidate) => candidate.id === 'work-alt',
    )
    if (
      account?.type !== 'oauth' ||
      !account.authLineageId ||
      !account.anthropicAccountUuid
    )
      throw new Error('Expected the current native fallback account binding')
    quotaManager.setFallback(
      'work-alt',
      {
        quota: {
          ...cachedQuota,
          accountIdentity: account.anthropicAccountUuid,
        },
        refreshAfter: now,
        checkedAt: now + 60_000,
      },
      account,
    )
    await expect(
      quotaManager.refreshFallback(
        'work-alt',
        'sk-ant-oat01-fb-access',
        account,
      ),
    ).rejects.toThrow('429')

    await mgr.tick()

    expect(primeCalls).toBe(0)
  })
})

async function expirePoolCredentialForPrime(
  runtime: ReturnType<typeof createNativeAccountRuntime>,
  routeId: string,
) {
  if (!testContext.migratedPool) throw new Error('Missing native Prime fixture')
  const before = await runtime.captureLocalSubject(routeId)
  const store = createNativePoolStore({
    paths: testContext.migratedPool.paths,
    quota: nativeQuotaCodec,
  })
  const rotated = await store.refresh(
    before.binding.rowId,
    async (credential) => ({
      access: `sk-ant-oat01-prime-expired-${routeId}`,
      refresh: credential.refresh,
      expires: Date.now() - 1_000,
    }),
  )
  expect(rotated.status).toBe('rotated')
  const after = await runtime.captureLocalSubject(routeId)
  expect(after.binding).toEqual(before.binding)
  expect(after.credentialFingerprint).toBe(before.credentialFingerprint)
}

async function primeWarningsAfterQuotaCheck(
  fallback: boolean,
  change: (
    runtime: ReturnType<typeof createNativeAccountRuntime>,
  ) => Promise<void>,
  getHostAuth = () =>
    Promise.resolve({ type: 'oauth' as const, ...syntheticMainHostAuth() }),
) {
  const dueQuota = {
    five_hour: {
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: new Date(Date.now() - 180_000).toISOString(),
      checkedAt: Date.now(),
    },
  }
  await useTempAccountFile(
    bindPoolAccounts(
      createFallbackStorage({
        accounts: fallback
          ? [
              {
                id: 'work-alt',
                type: 'oauth',
                access: 'sk-ant-oat01-fb-access',
                refresh: 'fb-refresh',
                expires: Date.now() + 8 * 60 * 60_000,
                quota: dueQuota,
              },
            ]
          : [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          mainQuota: fallback
            ? {
                five_hour: {
                  ...dueQuota.five_hour,
                  resetsAt: new Date(
                    Date.now() + 5 * 60 * 60_000,
                  ).toISOString(),
                },
              }
            : dueQuota,
        },
        prime: { enabled: true },
      }),
    ),
  )
  let modelRequests = 0
  let refreshRequests = 0
  globalThis.fetch = mock(
    withNativeBootstrap((input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        refreshRequests += 1
        return new Response('temporary refresh failure', { status: 503 })
      }
      if (url.includes('/v1/messages')) {
        modelRequests += 1
        return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } })
      }
      if (url.includes('/api/oauth/usage'))
        return freshPrimeQuotaResponse({
          five_hour: { utilization: 0, resets_at: dueQuota.five_hour.resetsAt },
        })
      throw new Error(`Unexpected test endpoint: ${url}`)
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin()
  await plugin.auth.loader(getHostAuth, { models: {} })
  const runtime = createNativeAccountRuntime({
    paths: testContext.migratedPool!.paths,
    host: 'opencode',
  })
  const manager = getPluginTestHandles(plugin).primeManager
  let changed = false
  // Change account availability after the manager obtained its claim identity.
  // Keep the real send adapter to verify its failure classification and logs.
  manager.options.refreshQuota = async () => {
    await change(runtime)
    changed = true
    return { quota: dueQuota, fresh: true }
  }
  const { __setLogTestSink, getLogLevel, setLogLevel } = await import(
    '@cortexkit/anthropic-auth-core'
  )
  const records: LogTestRecord[] = []
  const previousLevel = getLogLevel()
  setLogLevel('warn')
  __setLogTestSink((record) => records.push(record))
  try {
    await manager.tick()
  } finally {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
    runtime.close()
  }
  expect(changed).toBe(true)
  expect(modelRequests).toBe(0)
  return { records, refreshRequests }
}

describe('claude-prime — warn dedup (R3)', () => {
  // PrimeManager sends a minimal model request to start a five-hour window.
  // If refreshing its token fails after quota checking, the adapter must
  // return that failure to the manager. Only the manager logs the warning,
  // so one failed request produces one warning rather than duplicate alerts.

  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('R3: a fire-time main token refresh failure produces exactly one warn·prime·prime token refresh failed record (distinct from the generic fire-failed event)', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      false,
      async (runtime) => {
        await expirePoolCredentialForPrime(runtime, 'main')
      },
    )
    expect(refreshRequests).toBe(3)
    expect(
      records.filter(
        (record) =>
          record.channel === 'prime' &&
          record.level === 'warn' &&
          record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(1)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(0)
  })

  test('R3-precision: a fire-time main auth-unavailable (latestGetAuth null) failure logs the GENERIC `prime fire failed` (NOT `prime token refresh failed`)', async () => {
    let activationUnavailable = false
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      false,
      async () => {
        activationUnavailable = true
      },
      () => {
        if (activationUnavailable)
          return Promise.reject(
            new Error('prime: main auth loader is not available'),
          )
        return Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() })
      },
    )
    expect(refreshRequests).toBe(0)
    expect(
      records.filter(
        (record) => record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(0)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(1)
  })

  test('R3-precision: a fallback removed between fresh-check and fire logs `prime fire failed`', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      true,
      async (runtime) => {
        await runtime.remove('work-alt')
      },
    )
    expect(refreshRequests).toBe(0)
    expect(
      records.filter(
        (record) => record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(0)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(1)
  })

  test('R3: a fallback refreshAccount failure logs `prime token refresh failed`', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      true,
      async (runtime) => {
        await expirePoolCredentialForPrime(runtime, 'work-alt')
      },
    )
    expect(refreshRequests).toBe(3)
    expect(
      records.filter(
        (record) => record.message === 'prime token refresh failed',
      ),
    ).toHaveLength(1)
    expect(
      records.filter((record) => record.message === 'prime fire failed'),
    ).toHaveLength(0)
  })
})
