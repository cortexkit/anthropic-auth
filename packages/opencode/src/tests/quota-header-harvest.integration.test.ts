import { describe, expect, mock, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as filesystem from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  type AccountStorage,
  createNativeAccountRuntime,
  type LogTestRecord,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { getSidebarState, getSidebarStateFile } from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import type { createMockClient } from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindMainAccount,
  bindMainQuotaToAccount,
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  loginIssues as loginIssuesWithCtx,
  poolMainIdentity as poolMainIdentityWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  refreshPoolLoginElsewhere as refreshPoolLoginElsewhereWithCtx,
  refreshPoolMainElsewhere as refreshPoolMainElsewhereWithCtx,
  replacePoolMainLogin as replacePoolMainLoginWithCtx,
  requireKnownPoolSubject,
  syntheticFallbackAccountUuid,
  syntheticMainAccountUuid,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import { waitForLogRecord as waitForLogRecordWithCtx } from './support/opencode1-quota-feed.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  EMPTY_POST,
  getBodyLifetime,
  installOpencode1TestHooks,
  setSidebarWriteTestHooks as setSidebarWriteTestHooksWithCtx,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL, QUOTA_URL } from './test-fetch'

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
function poolMainIdentity(): string {
  return poolMainIdentityWithCtx(testContext)
}
function loginIssues(current: string, ...accesses: string[]) {
  return loginIssuesWithCtx(testContext, current, ...accesses)
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

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  describe('quota header harvest', () => {
    const quotaHeaders = {
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': '0.78',
      'anthropic-ratelimit-unified-5h-reset': '1784246400',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '1784628000',
    }

    const harvestStorage = (
      accounts: AccountStorage['accounts'] = [],
      overrides: Partial<AccountStorage> = {},
    ) =>
      createFallbackStorage({
        accounts,
        quota: { enabled: false },
        ...overrides,
      })

    function pauseHeaderPublication() {
      const lifetime = bodyLifetime()
      const entered = lifetime.gate()
      const release = lifetime.gate()
      const operations: Promise<boolean>[] = []
      const factory = Core.createNativeAccountRuntime
      const factorySpy = spyOn(
        Core,
        'createNativeAccountRuntime',
      ).mockImplementation((options) => {
        const runtime = factory(options)
        const publish = runtime.publishLocal.bind(runtime)
        runtime.publishLocal = (subject, patch) => {
          if (patch.quota?.source !== 'headers') return publish(subject, patch)
          // Pause before the real publisher runs; its ownership and version
          // checks remain unchanged when the test releases it.
          const operation = (async () => {
            entered.open()
            await release.wait
            return publish(subject, patch)
          })()
          operations.push(operation)
          lifetime.trackDetached(Promise.allSettled([operation]))
          return operation
        }
        return runtime
      })
      return { entered, release, operations, factorySpy }
    }
    const apiFallbackForHeaderTests = {
      id: 'header-api',
      type: 'api' as const,
      apiKey: 'header-key',
      baseURL: 'https://example.test/claude',
      authHeader: 'authorization-bearer' as const,
    }

    for (const exhausted of [true, false]) {
      test(`pending seven-day poll ${exhausted ? 'confirms general exhaustion for paid fallback' : 'with quota left cannot license paid fallback'} while runtime sync is held`, async () => {
        await useTempAccountFile(
          harvestStorage([apiFallbackForHeaderTests], {
            routing: { mode: 'fallback-first' },
            quota: { enabled: true },
          }),
        )
        const lifetime = bodyLifetime()
        const entered = lifetime.gate()
        const release = lifetime.gate()
        let servingRuntime:
          | ReturnType<typeof Core.createNativeAccountRuntime>
          | undefined
        const factory = Core.createNativeAccountRuntime
        const factorySpy = spyOn(
          Core,
          'createNativeAccountRuntime',
        ).mockImplementation((options) => {
          servingRuntime = factory(options)
          return servingRuntime
        })
        lifetime.deferCleanup(() => factorySpy.mockRestore())
        const authorizations: Array<string | null> = []
        globalThis.fetch = mock(
          withNativeAdmission(
            (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              if (extractUrl(input) === QUOTA_URL)
                return Promise.resolve(
                  Response.json({
                    five_hour: { utilization: 20 },
                    seven_day: { utilization: exhausted ? 100 : 20 },
                  }),
                )
              authorizations.push(
                new Headers(init?.headers).get('authorization'),
              )
              return Promise.resolve(new Response('ok'))
            },
          ),
        ) as unknown as typeof fetch
        const result = await loadFetch()
        if (!servingRuntime || !testContext.migratedPool)
          throw new Error('Missing serving pool')
        const runtime = servingRuntime
        const runtimePath = testContext.migratedPool.paths.runtime
        const realOpen = filesystem.open
        let intercepted = false
        const openSpy = spyOn(filesystem, 'open').mockImplementation(
          async (path, flags, mode) => {
            const file = await realOpen(path, flags, mode)
            if (String(path).startsWith(`${runtimePath}.native-runtime.`)) {
              const sync = file.sync.bind(file)
              file.sync = async () => {
                const staged: {
                  accounts: Record<string, { quotaErrorClearedAt?: number }>
                } = JSON.parse(await readFile(path, 'utf8'))
                if (
                  !intercepted &&
                  Object.values(staged.accounts).some(
                    (entry) => entry.quotaErrorClearedAt,
                  )
                ) {
                  intercepted = true
                  entered.open()
                  await release.wait
                }
                return sync()
              }
            }
            return file
          },
        )
        lifetime.deferCleanup(() => openSpy.mockRestore())
        await runtime.fetchQuota('main')
        await entered.wait
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          exhausted ? 'Bearer header-key' : 'Bearer sk-ant-oat01-main-access',
        ])
        // Polls replace the per-account entry also used by response headers.
        // Its exhaustion flag must mean no five-hour or seven-day quota remains;
        // rounding a display to 100% is not permission to spend on an API key.
        expect(runtime.quotaObservations.get('main')?.generalExhausted).toBe(
          exhausted,
        )
        release.open()
        await runtime.drainQuotaPublications()
      })
    }

    test('pending quota routes without waiting for header publication', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
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
      try {
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        await pause.entered.wait
        expect(
          getPluginTestHandles(plugin).quotaManager.getMain(poolMainIdentity()),
        ).toBeNull()
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer header-key',
        ])
        expect((await readAccountStorage())?.quota?.mainQuota).toBeUndefined()
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
      }
    })

    test('pending rounded header usage cannot license API fallback', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get('authorization'))
          return Promise.resolve(
            new Response('ok', {
              headers: {
                ...quotaHeaders,
                'anthropic-ratelimit-unified-5h-utilization': '0.995',
              },
            }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      try {
        await result.fetch(MESSAGES_URL, EMPTY_POST)
        await pause.entered.wait
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-main-access',
        ])
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
      }
    })

    test('pending quota from a superseded credential epoch cannot license API fallback', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      try {
        await result.fetch(MESSAGES_URL, EMPTY_POST)
        await pause.entered.wait
        await replacePoolMainLogin(
          {
            access: 'sk-ant-oat01-new-epoch',
            refresh: 'new-epoch-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
          { sameAccount: false, accountIdentity: poolMainIdentity() },
        )
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-new-epoch',
        ])
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
      }
    })

    test('refused header publication cannot persist superseded-epoch quota', async () => {
      await useTempAccountFile(
        harvestStorage([apiFallbackForHeaderTests], {
          routing: { mode: 'fallback-first' },
        }),
      )
      const pause = pauseHeaderPublication()
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      setLogLevel('debug')
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')
      try {
        await result.fetch(MESSAGES_URL, EMPTY_POST)
        await pause.entered.wait
        if (!testContext.migratedPool)
          throw new Error('This test has no migrated pool')
        const reader = createNativeAccountRuntime({
          paths: testContext.migratedPool.paths,
          host: 'opencode',
        })
        try {
          const before = await reader.captureLocalSubject('main')
          await replacePoolMainLogin(
            {
              access: 'sk-ant-oat01-new-epoch-access',
              refresh: 'main-refresh',
              expires: Date.now() + 8 * 60 * 60_000,
            },
            { sameAccount: false, accountIdentity: poolMainIdentity() },
          )
          const after = await reader.captureLocalSubject('main')
          expect(after.binding.credentialEpoch).toBeGreaterThan(
            before.binding.credentialEpoch,
          )
          expect(after.binding.identity).toBe(before.binding.identity)
          expect(after.version?.accessFingerprint).not.toBe(
            before.version?.accessFingerprint,
          )
        } finally {
          reader.close()
        }
        pause.release.open()
        expect(await pause.operations[0]).toBe(false)
        expect((await readNativeRuntimeState()).main?.quota?.source).not.toBe(
          'headers',
        )
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'discarded pending response quota',
          'refused pending observation cleanup',
        )
        expect((await result.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          'Bearer sk-ant-oat01-new-epoch-access',
        ])
      } finally {
        pause.release.open()
        await Promise.allSettled(pause.operations)
        pause.factorySpy.mockRestore()
        __setLogTestSink(null)
        setLogLevel('info')
      }
    })

    function installRelayWebSocket(responseHeaders: Record<string, string>) {
      const originalWebSocket = globalThis.WebSocket

      class RelayWebSocket extends EventTarget {
        binaryType = 'arraybuffer'

        constructor() {
          super()
          queueMicrotask(() => {
            this.dispatchEvent(new Event('open'))
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'ready',
                  state: null,
                }),
              }),
            )
          })
        }

        send(data: string) {
          const payload = JSON.parse(data)
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'accepted',
                  id: payload.id,
                  hash: payload.next_hash,
                  revision: payload.revision,
                }),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'response_start',
                  id: payload.id,
                  status: 200,
                  headers: responseHeaders,
                }),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: Buffer.from(
                  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ),
              }),
            )
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'done',
                  id: payload.id,
                }),
              }),
            )
          })
        }

        close() {
          this.dispatchEvent(new Event('close'))
        }
      }

      globalThis.WebSocket = RelayWebSocket as unknown as typeof WebSocket
      return () => {
        globalThis.WebSocket = originalWebSocket
      }
    }

    async function loadFetch(
      getAccessToken: () => string = () => 'sk-ant-oat01-main-access',
    ) {
      const plugin = await getPlugin()
      return plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: getAccessToken(),
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
    }

    // Read the account runtime state that stores response-header quota.
    async function waitForState(predicate: (state: any) => boolean) {
      let lastState: unknown
      for (let attempt = 0; attempt < 200; attempt++) {
        // Each test checks its required fields in the persisted projection.
        const state: any = await readNativeRuntimeState()
        lastState = state
        if (predicate(state)) return state
        await Bun.sleep(10)
      }
      throw new Error(
        `quota state did not persist: ${JSON.stringify(lastState)}`,
      )
    }

    test('main 200 response pushes unified headers before returning the response', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(new Response('main-ok', { headers: quotaHeaders })),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(await response.text()).toBe('main-ok')
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      // Header quota belongs to the account UUID, not its rotating token.
      expect(state.main.quota.accountIdentity).toBe(poolMainIdentity())
    })

    test('fresh header exhaustion licenses API-key fallback on the next request', async () => {
      await useTempAccountFile(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'kie-opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
          quota: { enabled: false },
        }),
      )
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (extractUrl(input).includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: poolMainIdentity() },
                }),
              )
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            authorizations.push(authorization)
            return Promise.resolve(
              new Response('ok', {
                headers:
                  authorization === 'Bearer sk-ant-oat01-main-access'
                    ? {
                        ...quotaHeaders,
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                      }
                    : undefined,
              }),
            )
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-main-access',
        'Bearer kie-key',
      ])
    })

    test('stale header exhaustion does not license API-key fallback', async () => {
      const checkedAt = Date.now() - 60 * 60 * 1000
      await useTempAccountFile(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'kie-opus',
              type: 'api',
              apiKey: 'kie-key',
              baseURL: 'https://api.kie.ai/claude',
              authHeader: 'authorization-bearer',
            },
          ],
          quota: {
            enabled: false,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt,
              },
              source: 'headers',
              checkedAt,
            },
            mainQuotaCheckedAt: checkedAt,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        }),
      )
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          authorizations.push(new Headers(init?.headers).get('authorization'))
          return Promise.resolve(new Response('ok'))
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
    })
    test('websocket relay response_start pushes unified headers for the served account', async () => {
      await useTempAccountFile(
        harvestStorage([], {
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        }),
      )
      // The relay request travels over the WebSocket; HTTP is used only for
      // the pool's account check of the main login before it serves.
      const providerFetch = globalThis.fetch
      globalThis.fetch = mock(
        withNativeAdmission(providerFetch),
      ) as unknown as typeof fetch
      const restoreWebSocket = installRelayWebSocket(quotaHeaders)
      const result = await loadFetch()

      try {
        const response = await result.fetch(MESSAGES_URL, {
          ...EMPTY_POST,
          body: JSON.stringify({
            ...JSON.parse(EMPTY_POST.body),
            stream: true,
          }),
          headers: { 'x-session-affinity': 'quota-relay-websocket' },
        })
        expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe(
          'true',
        )
        await response.text()
      } finally {
        restoreWebSocket()
      }

      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      // Header quota belongs to the account UUID, not its rotating token.
      expect(state.main.quota.accountIdentity).toBe(poolMainIdentity())
    })

    test('relay fallback to direct harvests quota headers exactly once', async () => {
      await useTempAccountFile(
        harvestStorage([], {
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'http',
          },
        }),
      )
      const records: LogTestRecord[] = []
      const affinity = 'quota-relay-direct-fallback'
      // A marker in this request's body tells its own sends apart from any
      // other request that reaches the mock. When an earlier test overruns
      // Bun's timeouts, its body and its teardown keep running into this test:
      // its own model request can arrive here, and its teardown can re-enable
      // profile hydration, which sends GET /api/oauth/profile. Counting those
      // would report a duplicate send that this request never made.
      const probe = 'relay-direct-fallback-probe'
      let relay503Calls = 0
      let directCalls = 0
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: string | URL | Request, init?: RequestInit) => {
            const url = extractUrl(input)
            const body = typeof init?.body === 'string' ? init.body : ''
            if (url === 'https://relay.example.test/') {
              let relayAffinity: unknown
              try {
                relayAffinity = JSON.parse(body).affinity
              } catch {}
              if (relayAffinity === affinity) relay503Calls += 1
              return Promise.resolve(
                new Response('relay unavailable', { status: 503 }),
              )
            }
            if (
              url.startsWith(MESSAGES_URL) &&
              init?.method === 'POST' &&
              body.includes(probe)
            ) {
              directCalls += 1
              return Promise.resolve(
                new Response('direct', { headers: quotaHeaders }),
              )
            }
            return Promise.resolve(new Response('unrelated', { status: 404 }))
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      try {
        const response = await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ role: 'user', content: probe }],
          }),
          headers: { 'x-session-affinity': affinity },
        })
        expect(await response.text()).toBe('direct')
        expect(relay503Calls).toBe(1)
        expect(directCalls).toBe(1)
        await waitForState((value) => value.main?.quota?.source === 'headers')
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
          'published direct-fallback quota log',
        )
        expect(
          records.filter(
            (record) =>
              record.channel === 'quota' &&
              record.message === 'harvested response quota',
          ),
        ).toHaveLength(1)
      } finally {
        __setLogTestSink(null)
        setLogLevel('info')
      }
    })

    test('websocket optimistic response headers without quota data do not persist', async () => {
      await useTempAccountFile(
        harvestStorage([], {
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        }),
      )
      // The relay request travels over the WebSocket; HTTP is used only for
      // the pool's account check of the main login before it serves.
      const providerFetch = globalThis.fetch
      globalThis.fetch = mock(
        withNativeAdmission(providerFetch),
      ) as unknown as typeof fetch
      const restoreWebSocket = installRelayWebSocket({
        'content-type': 'text/event-stream',
      })
      const result = await loadFetch()

      try {
        const response = await result.fetch(MESSAGES_URL, {
          ...EMPTY_POST,
          body: JSON.stringify({
            ...JSON.parse(EMPTY_POST.body),
            stream: true,
          }),
          headers: { 'x-session-affinity': 'quota-relay-synthetic-only' },
        })
        expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe(
          'true',
        )
        await response.text()
      } finally {
        restoreWebSocket()
      }

      await Bun.sleep(30)
      expect(
        (await readAccountStorage())?.quota?.mainQuota?.source,
      ).toBeUndefined()
    })

    test('quota-only publication survives native token refresh without admitting stale metadata', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(async () => Response.json({})),
      ) as unknown as typeof fetch
      if (!testContext.migratedPool) throw new Error('Expected migrated pool')
      const reader = createNativeAccountRuntime({
        paths: testContext.migratedPool.paths,
        host: 'opencode',
      })
      try {
        expect((await reader.authorizeLocal('main')).status).toBe('usable')
        const before = requireKnownPoolSubject(
          await reader.captureLocalSubject('main'),
        )
        await refreshPoolMainElsewhere({
          ...syntheticMainHostAuth(),
          access: 'sk-ant-oat01-refreshed-quota-access',
        })
        const after = await reader.captureLocalSubject('main')
        expect(after.binding.credentialEpoch).toBe(
          before.binding.credentialEpoch,
        )
        expect(after.binding.identity).toBe(before.binding.identity)
        expect(after.version?.accessFingerprint).not.toBe(
          before.version?.accessFingerprint,
        )
        const quota: OAuthQuotaSnapshot = {
          accountIdentity: before.binding.identity,
          source: 'headers',
          checkedAt: Date.now(),
          five_hour: {
            usedPercent: 78,
            remainingPercent: 22,
            checkedAt: Date.now(),
          },
        }
        expect(
          await reader.publishLocal(before, { quota, lastUsed: Date.now() }),
        ).toBe(false)
        expect(await reader.publishLocal(before, { quota })).toBe(true)
        expect(
          (await reader.read()).accounts.find(
            (account) => account.id === 'main',
          )?.quota?.five_hour?.usedPercent,
        ).toBe(78)
        expect(
          await reader.publishLocal(before, { lastUsed: Date.now() }),
        ).toBe(false)
      } finally {
        reader.close()
      }
    })

    test('main header push persists after access-token rotation for the same account', async () => {
      const initialAuth = {
        ...syntheticMainHostAuth(),
        access: 'sk-ant-oat01-old-main-access',
      }
      let liveAccessToken = initialAuth.access
      const existingQuota = {
        five_hour: { usedPercent: 11, remainingPercent: 89, checkedAt: 1 },
        source: 'poll' as const,
        checkedAt: 1,
      }
      await useTempAccountFile(
        bindMainQuotaToAccount(
          createFallbackStorage({
            mainAccountId: 'account-x',
            accounts: [],
            quota: {
              enabled: false,
              mainQuota: existingQuota,
              mainQuotaCheckedAt: 1,
            },
          }),
          initialAuth.access,
        ),
        initialAuth,
      )
      const requestStarted = bodyLifetime().gate()
      const releaseResponse = bodyLifetime().gate()
      const requestAuthorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (!extractUrl(input).includes('/v1/messages'))
              return Response.json({})
            requestAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
            requestStarted.open()
            await releaseResponse.wait
            return new Response('main-ok', { headers: quotaHeaders })
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch(() => liveAccessToken)
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      setLogLevel('debug')
      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      try {
        await Promise.race([
          requestStarted.wait,
          responsePromise.then(() => {
            throw new Error('Expected a held main model request')
          }),
        ])
        if (!testContext.migratedPool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: testContext.migratedPool.paths,
          host: 'opencode',
        })
        try {
          const before = requireKnownPoolSubject(
            await reader.captureLocalSubject('main'),
          )
          liveAccessToken = 'sk-ant-oat01-new-main-access'
          await refreshPoolMainElsewhere({
            ...initialAuth,
            access: liveAccessToken,
          })
          const after = await reader.captureLocalSubject('main')
          expect(after.binding.credentialEpoch).toBe(
            before.binding.credentialEpoch,
          )
          expect(after.binding.identity).toBe(before.binding.identity)
          expect(after.version?.accessFingerprint).not.toBe(
            before.version?.accessFingerprint,
          )
          expect(
            await reader.publishLocal(before, {
              quota: {
                ...existingQuota,
                accountIdentity: syntheticMainAccountUuid,
                five_hour: {
                  usedPercent: 99,
                  remainingPercent: 1,
                  checkedAt: Date.now(),
                },
                checkedAt: Date.now(),
              },
              lastUsed: Date.now(),
            }),
          ).toBe(false)
          expect(
            (await reader.read()).accounts.find(
              (account) => account.id === 'main',
            )?.quota?.five_hour?.usedPercent,
          ).toBe(11)
        } finally {
          reader.close()
        }
        releaseResponse.open()
        await responsePromise
        const state = await waitForState(
          (value) => value.main?.quota?.source === 'headers',
        )
        const reloaded = await readAccountStorage()
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
          'published refreshed-main quota log',
        )
        expect(
          records.some(
            (record) =>
              record.channel === 'quota' &&
              record.message === 'harvested response quota',
          ),
        ).toBe(true)
        expect(requestAuthorizations[0]).toBe(
          'Bearer sk-ant-oat01-old-main-access',
        )
        expect(state.main.quota.five_hour.usedPercent).toBe(78)
        expect(state.main.quota.accountIdentity).toBe(syntheticMainAccountUuid)
        expect(state.main.quotaToken).toBeUndefined()
        expect(reloaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
        expect(reloaded?.quota?.mainQuota?.accountIdentity).toBe(
          syntheticMainAccountUuid,
        )
        // In the policy view, mainQuotaToken is an account UUID, not a token.
        expect(reloaded?.quota?.mainQuotaToken).toBe(syntheticMainAccountUuid)
        expect(JSON.stringify(reloaded)).not.toContain(initialAuth.access)
        expect(JSON.stringify(reloaded)).not.toContain(liveAccessToken)
      } finally {
        releaseResponse.open()
        await Promise.allSettled([responsePromise])
        __setLogTestSink(null)
        setLogLevel('info')
      }
    })

    test('fallback header push persists after access-token rotation for the same account', async () => {
      const fallbackTemplate = createFallbackStorage()
        .accounts[0] as OAuthAccount
      const oldAccess = 'sk-ant-oat01-old-fallback-access'
      const newAccess = 'sk-ant-oat01-new-fallback-access'
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            accounts: [
              {
                ...fallbackTemplate,
                access: oldAccess,
                quota: fallbackTemplate.quota,
              },
            ],
            quota: { enabled: false },
          }),
        ),
      )
      let messageCalls = 0
      const fallbackStarted = bodyLifetime().gate()
      const releaseFallback = bodyLifetime().gate()
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock(
        withNativeAdmission(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = extractUrl(input)
            if (url.includes('/api/oauth/usage'))
              return new Response('usage-unavailable', { status: 500 })
            if (!url.includes('/v1/messages')) return Response.json({})
            authorizations.push(new Headers(init?.headers).get('authorization'))
            if (++messageCalls === 1)
              return new Response('limited', { status: 429 })
            fallbackStarted.open()
            await releaseFallback.wait
            return new Response('fallback-ok', { headers: quotaHeaders })
          },
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      try {
        await Promise.race([
          fallbackStarted.wait,
          responsePromise.then(() => {
            throw new Error('Expected a held fallback request')
          }),
        ])
        if (!testContext.migratedPool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: testContext.migratedPool.paths,
          host: 'opencode',
        })
        try {
          const before = await reader.captureLocalSubject('fallback-1')
          loginIssues(oldAccess, newAccess)
          await refreshPoolLoginElsewhere('fallback-1', {
            access: newAccess,
            refresh: fallbackTemplate.refresh,
            expires: Date.now() + 8 * 60 * 60_000,
          })
          const after = await reader.captureLocalSubject('fallback-1')
          expect(after.binding.credentialEpoch).toBe(
            before.binding.credentialEpoch,
          )
          expect(after.binding.identity).toBe(before.binding.identity)
          expect(after.version?.accessFingerprint).not.toBe(
            before.version?.accessFingerprint,
          )
        } finally {
          reader.close()
        }
        releaseFallback.open()
        await responsePromise
        const state = await waitForState(
          (value) =>
            value.accounts?.['fallback-1']?.quota?.source === 'headers',
        )
        expect(state.accounts['fallback-1'].quota.accountIdentity).toBe(
          syntheticFallbackAccountUuid(0),
        )
        expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(
          78,
        )
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-main-access',
          `Bearer ${oldAccess}`,
        ])
      } finally {
        releaseFallback.open()
        await Promise.allSettled([responsePromise])
      }
    })

    test('fallback header push does not persist onto a different account identity', async () => {
      const accountXQuota: OAuthQuotaSnapshot = {
        accountIdentity: syntheticFallbackAccountUuid(0),
        five_hour: { usedPercent: 11, remainingPercent: 89, checkedAt: 1 },
      }
      const template = createFallbackStorage().accounts[0] as OAuthAccount
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            accounts: [
              {
                ...template,
                id: 'account-x',
                lastRefreshError: {
                  message: 'dead fallback',
                  checkedAt: Date.now(),
                  permanent: true,
                  // Import a failure bound to the exact stored refresh token.
                  tokenHash: createHash('sha256')
                    .update(template.refresh)
                    .digest('hex'),
                  accountIdentity: syntheticFallbackAccountUuid(0),
                },
                quota: accountXQuota,
              },
              {
                ...template,
                access: 'sk-ant-oat01-served-account-access',
                refresh: 'served-account-refresh',
                quota: {
                  ...accountXQuota,
                  accountIdentity: syntheticFallbackAccountUuid(1),
                },
              },
            ],
            quota: { enabled: false },
          }),
        ),
      )
      let messageCalls = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: Parameters<typeof fetch>[0]) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage'))
            return Promise.resolve(
              new Response('usage-unavailable', { status: 500 }),
            )
          if (!url.includes('/v1/messages'))
            return Promise.resolve(Response.json({}))
          return Promise.resolve(
            ++messageCalls === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const before = await readNativeRuntimeState()
      expect(before.accounts['account-x']?.lastRefreshError?.permanent).toBe(
        true,
      )
      const result = await loadFetch()
      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      expect(state.accounts['account-x'].quota).toEqual(accountXQuota)
      expect(state.accounts['fallback-1'].quota.accountIdentity).toBe(
        syntheticFallbackAccountUuid(1),
      )
      expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(78)
    })

    test('main header push preserves persisted poll backoff across reload', async () => {
      const pollBackoff = {
        status: 429,
        accountIdentity: syntheticMainAccountUuid,
        message: 'Claude quota check failed: 429 — rate limited',
        checkedAt: Date.now(),
        nextRetryAt: Date.now() + 60_000,
        retryCount: 1,
      }
      await useTempAccountFile(
        bindMainAccount(
          createFallbackStorage({
            accounts: [],
            quota: {
              enabled: false,
              mainLastQuotaApiError: pollBackoff,
            },
          }),
        ),
      )
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(new Response('main-ok', { headers: quotaHeaders })),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'main-ok',
      )
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      const reloaded = await readAccountStorage()

      // Public native views retain backoff fields but hide stored error text.
      expect(state.main.lastQuotaApiError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      expect(reloaded?.quota?.mainLastQuotaApiError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(reloaded?.quota?.mainQuota?.source).toBe('headers')
    })

    test('primary adapter harvests one response frame and makes no corroborating usage request', async () => {
      await useTempAccountFile(harvestStorage())
      let messageCalls = 0
      let usageCalls = 0
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage')) usageCalls++
          if (url.includes('/v1/messages')) messageCalls++
          return Promise.resolve(new Response('ok', { headers: quotaHeaders }))
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )

      expect(messageCalls).toBe(1)
      expect(usageCalls).toBe(0)
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'harvested response quota',
        'published primary quota log',
      )
      expect(
        records.filter(
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
        ),
      ).toHaveLength(1)
      expect(state.main.quota.source).toBe('headers')
      __setLogTestSink(null)
      setLogLevel('info')
    })

    test('fallback-served response updates that fallback and not main', async () => {
      await useTempAccountFile(harvestStorage(createFallbackStorage().accounts))
      let messages = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              }),
            )
          }
          messages++
          return Promise.resolve(
            messages === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'fallback-ok',
      )
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      expect(state.main?.quota?.source).not.toBe('headers')
    })

    test('fallback header push preserves persisted poll backoff across reload', async () => {
      const pollBackoff = {
        status: 429,
        accountIdentity: syntheticFallbackAccountUuid(0),
        message: 'Claude quota check failed: 429 — rate limited',
        checkedAt: Date.now(),
        nextRetryAt: Date.now() + 60_000,
        retryCount: 1,
      }
      const fallback = createFallbackStorage().accounts[0]
      if (fallback?.type !== 'oauth') {
        throw new Error('expected OAuth fallback fixture')
      }
      await useTempAccountFile(
        bindPoolAccounts(
          harvestStorage([{ ...fallback, lastQuotaRefreshError: pollBackoff }]),
        ),
      )
      let messages = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              }),
            )
          }
          messages++
          return Promise.resolve(
            messages === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'fallback-ok',
      )
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      const reloaded = await readAccountStorage()
      const reloadedFallback = reloaded?.accounts.find(
        (account): account is OAuthAccount =>
          account.id === 'fallback-1' && account.type === 'oauth',
      )

      expect(state.accounts['fallback-1'].lastQuotaRefreshError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(78)
      expect(reloadedFallback?.lastQuotaRefreshError).toEqual({
        ...pollBackoff,
        message: 'OAuth operation failed',
      })
      expect(reloadedFallback?.quota?.source).toBe('headers')
    })

    test('sidebar state reflects header-pushed freshness and served fallback attribution', async () => {
      await useTempAccountFile(harvestStorage(createFallbackStorage().accounts))
      let messages = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 10 },
              }),
            )
          }
          messages++
          return Promise.resolve(
            messages === 1
              ? new Response('limited', { status: 429 })
              : new Response('fallback-ok', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForSidebarState(
        (value) =>
          value.activeId === 'fallback-1' &&
          value.fallbacks[0]?.quota?.five_hour?.usedPercent === 78,
      )

      expect(state.main.quota?.five_hour?.usedPercent).not.toBe(78)
      expect(state.fallbacks[0]?.id).toBe('fallback-1')
      expect(state.lastUpdated).toBeGreaterThan(0)
    })

    test('non-quota response does not push or persist quota', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(() => Promise.resolve(new Response('ok'))),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await Bun.sleep(30)

      expect(
        (await readAccountStorage())?.quota?.mainQuota?.source,
      ).toBeUndefined()
    })

    test('non-finite utilization headers leave stored quota untouched', async () => {
      const existingQuota = {
        accountIdentity: syntheticMainAccountUuid,
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 1,
        },
        fallbackAdvised: true,
        source: 'poll' as const,
        checkedAt: 1,
      }
      await useTempAccountFile(
        bindMainQuotaToAccount(
          createFallbackStorage({
            accounts: [],
            quota: {
              enabled: false,
              mainQuota: existingQuota,
              mainQuotaCheckedAt: 1,
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            },
          }),
        ),
      )
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('ok', {
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': 'garbage',
                'anthropic-ratelimit-unified-7d-utilization': 'NaN',
              },
            }),
          ),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await Bun.sleep(30)

      expect((await readAccountStorage())?.quota?.mainQuota).toEqual(
        existingQuota,
      )
    })

    test('malformed quota headers never reject or replace the original response', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('original', {
              status: 202,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.5',
                'anthropic-ratelimit-unified-5h-reset': '1e308',
              },
            }),
          ),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(response.status).toBe(202)
      expect(await response.text()).toBe('original')
    })

    test('header push persists source headers and refreshes sidebar checkedAt without a usage poll', async () => {
      await useTempAccountFile(harvestStorage())
      const published = bodyLifetime().gate()
      const sidebarPath = getSidebarStateFile()
      // Returning the model response does not join quota persistence or its
      // sidebar refresh. Wait for the atomic sidebar publication containing
      // these headers, rather than assuming it fits a polling deadline.
      __setSidebarStateWriteTestHooks(
        {
          afterRename: async () => {
            const state = await getSidebarState(sidebarPath)
            if (state.main.quota?.five_hour?.usedPercent === 78)
              published.open()
          },
        },
        sidebarPath,
      )
      try {
        let usageCalls = 0
        globalThis.fetch = mock(
          withNativeAdmission((input: string | URL | Request) => {
            if (extractUrl(input).includes('/api/oauth/usage')) usageCalls++
            return Promise.resolve(
              new Response('ok', { headers: quotaHeaders }),
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
              expires: Date.now() + 100000,
            }),
          { models: {} },
        )

        const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
        expect(response.status).toBe(200)
        await response.text()
        await published.wait
        // The plugin's own views take the accepted reading at once: its quota
        // cache and the sidebar it just published.
        expect(
          getPluginTestHandles(plugin).quotaManager.getMain(poolMainIdentity())
            ?.quota.five_hour?.usedPercent,
        ).toBe(78)
        const state = await getSidebarState(sidebarPath)
        expect(state.main.quota?.five_hour?.usedPercent).toBe(78)
        expect(state.lastUpdated).toBeGreaterThan(0)

        // The pool store queues quota readings and commits them to disk later
        // (about 100 ms after the first reading, then at most once per 30 s per
        // store handle), so the file need not hold the reading yet, and a file
        // watcher can miss the commit's final rename. Closing the plugin's
        // account runtime commits the queued readings at once; a fresh reader
        // then finds them on disk.
        await getPluginTestHandles(plugin).scopedRuntime.close()
        const storage = await readAccountStorage()
        expect(storage?.quota?.mainQuota?.source).toBe('headers')
        expect(storage?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
        expect(storage?.quota?.mainQuotaCheckedAt).toBeGreaterThan(0)
        expect(usageCalls).toBe(0)
      } finally {
        __setSidebarStateWriteTestHooks(null, sidebarPath)
      }
    })

    test('successful harvest emits one quota debug record without raw headers', async () => {
      await useTempAccountFile(harvestStorage())
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(new Response('ok', { headers: quotaHeaders })),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      await result.fetch(MESSAGES_URL, EMPTY_POST)

      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'harvested response quota',
        'published quota log',
      )
      const harvested = records.filter(
        (record) =>
          record.channel === 'quota' &&
          record.message === 'harvested response quota',
      )
      expect(harvested).toHaveLength(1)
      expect(JSON.stringify(harvested[0])).not.toContain('anthropic-ratelimit')
      __setLogTestSink(null)
      setLogLevel('info')
    })

    test('repeated out-of-range resets do not warn and restore log state', async () => {
      await useTempAccountFile(harvestStorage())
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('ok', {
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.5',
                'anthropic-ratelimit-unified-5h-reset': '1e308',
              },
            }),
          ),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(
        records.filter(
          (record) =>
            record.channel === 'quota' &&
            record.message === 'failed to normalize response quota headers',
        ),
      ).toHaveLength(0)
      __setLogTestSink(null)
      setLogLevel('info')
    })
  })
})
