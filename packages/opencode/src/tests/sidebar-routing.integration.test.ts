import { afterEach, describe, expect, mock } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import {
  type AccountStorage,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  createNativePoolStore,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import {
  __setInitialSidebarRoutingTestHooks,
  drainSidebarWrites,
  getSidebarState,
  getSidebarStateFile,
  resolveActiveAccount,
  setSidebarState,
} from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  expectHandledCommandResponse,
} from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  addPoolOAuthAccount as addPoolOAuthAccountWithCtx,
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  nativeAdmissionAnswer as nativeAdmissionAnswerWithCtx,
  publishPoolMetadata as publishPoolMetadataWithCtx,
  publishPoolQuota as publishPoolQuotaWithCtx,
  readNativeRuntimeState as readNativeRuntimeStateWithCtx,
  requireKnownPoolSubject,
  syntheticMainHostAuth,
  updatePoolSettings as updatePoolSettingsWithCtx,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  seedSidebarRouting,
  waitForNativePoolQuota,
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
  withDeadlockGuard,
} from './support/opencode1-test-context.ts'
import {
  extractUrl,
  MESSAGES_URL,
  PROFILE_URL,
  QUOTA_URL,
  TOKEN_URL,
} from './test-fetch'

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
function updatePoolSettings(
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  return updatePoolSettingsWithCtx(testContext, mutator)
}
function addPoolOAuthAccount(
  routeId: string,
  credential: { access: string; refresh: string; expires: number },
  accountIdentity?: string,
) {
  return accountIdentity === undefined
    ? addPoolOAuthAccountWithCtx(testContext, routeId, credential)
    : addPoolOAuthAccountWithCtx(
        testContext,
        routeId,
        credential,
        accountIdentity,
      )
}
function publishPoolQuota(routeId: string, quota: OAuthQuotaSnapshot) {
  return publishPoolQuotaWithCtx(testContext, routeId, quota)
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
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}
function getPluginForTest(
  client?: Parameters<typeof getPluginWithCtx>[1],
  directory?: string,
) {
  return client === undefined && directory === undefined
    ? getPluginWithCtx(testContext)
    : getPluginWithCtx(testContext, client, directory)
}

describe('desktop notice identity (#230)', () => {
  test('orders repeated notices before the same assistant with bounded IDs', async () => {
    const plugin = await getPluginForTest()
    const mint =
      getPluginTestHandles(plugin).notificationMessageIdBeforeAssistant
    const assistant = 'msg_0000000f0000BBBBBBBBBBBBBB'
    let previous = 'msg_0000000efffeAAAAAAAAAAAAAA'
    for (let index = 0; index < 20; index++) {
      const next = mint(assistant, previous)
      if (next === undefined) throw new Error('Expected an ordered notice ID')
      expect(typeof next).toBe('string')
      expect(next > previous).toBe(true)
      expect(next < assistant).toBe(true)
      previous = next
    }
    expect(mint(assistant, assistant)).toBeUndefined()
    expect(mint(assistant, 'msg_ffffffffffffAAAAAAAAAAAAAA')).toBeUndefined()
    expect(mint('invalid', previous)).toBeUndefined()
    expect(mint('msg_000000000000AAAAAAAAAAAAAA')).toBeUndefined()
    expect(
      mint(assistant, `msg_0000000effff${'z'.repeat(112)}`),
    ).toBeUndefined()
  })

  test('bounds notice identities by session and message, retaining recently used sessions', async () => {
    const plugin = await getPluginForTest()
    const track = getPluginTestHandles(plugin).trackDesktopNoticeMessageId
    const has = getPluginTestHandles(plugin).isDesktopNoticeMessage
    for (let index = 0; index < 128; index++) track(`ses_${index}`, 'msg_first')
    track('ses_0', 'msg_recent')
    track('ses_128', 'msg_first')
    expect(has('ses_0', 'msg_recent')).toBe(true)
    expect(has('ses_1', 'msg_first')).toBe(false)
    expect(has('ses_128', 'msg_first')).toBe(true)
    for (let index = 0; index < 5; index++) track('ses_128', `msg_${index}`)
    expect(has('ses_128', 'msg_0')).toBe(false)
    expect(has('ses_128', 'msg_1')).toBe(true)
    expect(has('ses_128', 'msg_4')).toBe(true)
    await plugin.event?.({
      event: {
        type: 'session.deleted',
        properties: { info: { id: 'ses_128' } },
      },
    })
    expect(has('ses_128', 'msg_4')).toBe(false)
  })
})

describe('sidebar needsReauth (dead-fallback indicator)', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function fallbackWithRefreshError(status: number) {
    const refresh = 'fallback-refresh'
    const now = Date.now()
    // A genuinely-dead token returns 400 invalid_grant; only that classifies as
    // permanent (a bare 400 / other OAuth errors do not).
    const body = status === 400 ? '{"error":"invalid_grant"}' : 'boom'
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(status, body),
      now,
      accountIdentity: 'fallback-1',
    })
    return createFallbackStorage({
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'sk-ant-oat01-fallback-access',
          refresh,
          expires: now + 5 * 60 * 60 * 1000,
          lastRefreshError: error,
        },
      ],
    })
  }

  test('dead (400 invalid_grant) fallback → needsReauth true', async () => {
    await useTempAccountFile(fallbackWithRefreshError(400))
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
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.needsReauth === true,
    )
    expect(state.fallbacks[0]?.needsReauth).toBe(true)
  })

  test('transient (429 rate-limited) fallback → needsReauth false', async () => {
    await useTempAccountFile(fallbackWithRefreshError(429))
    const defaultFetch = globalThis.fetch
    let tokenCalls = 0
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url === TOKEN_URL) {
        tokenCalls += 1
        return Promise.reject(
          new Error('TOKEN_URL is outside this transient quota test'),
        )
      }
      if (url === QUOTA_URL) {
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
            limits: [],
          }),
        )
      }
      return defaultFetch(input, init)
    }) as unknown as typeof fetch

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
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.needsReauth === false,
    )
    expect(state.fallbacks[0]?.needsReauth).toBe(false)
    expect(tokenCalls).toBe(0)
  })
})

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('boot seeds fallback-first sidebar routing from the first enabled OAuth fallback', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('boot preserves fresh sidebar routing from another live session', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
  })

  test('boot re-reads sidebar routing written after plugin creation', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )

    const plugin = await getPlugin()
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())
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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
  })

  test('boot reads preserved routing after its asynchronous storage load', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )

    let sequence = 0
    let sidebarReadAt = 0
    let storageLoadedAt = 0
    let storageLoadStarted!: () => void
    const storageLoadPaused = new Promise<void>((resolve) => {
      storageLoadStarted = resolve
    })
    let resumeStorageLoad!: () => void
    const storageLoadResumed = new Promise<void>((resolve) => {
      resumeStorageLoad = resolve
    })
    __setInitialSidebarRoutingTestHooks({
      beforeSidebarRead: () => {
        sidebarReadAt = ++sequence
      },
      beforeStorageLoad: async () => {
        storageLoadStarted()
        await storageLoadResumed
      },
      afterStorageLoad: () => {
        storageLoadedAt = ++sequence
      },
    })

    const plugin = await getPlugin()
    const loaderResult = plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await storageLoadPaused
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())
    resumeStorageLoad()
    await loaderResult
    await drainSidebarWrites()

    expect(storageLoadedAt).toBeLessThan(sidebarReadAt)
    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
  })

  test('boot write preserves routing written after its initial resolution', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    const foreignUpdatedAt = Date.now()
    const resolvedByBoot = {
      ...(await getSidebarState()),
      activeId: 'main',
      route: 'main',
      lastUpdated: foreignUpdatedAt - 1000,
    }
    await seedSidebarRouting('work-alt', 'fallback-first', foreignUpdatedAt)

    await setSidebarState(resolvedByBoot, getSidebarStateFile(), {
      routingAuthoritative: false,
      resolvePreservedRouting: (current) =>
        current.activeId === 'work-alt'
          ? { activeId: current.activeId, route: current.route }
          : undefined,
    })

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-alt')
    expect(state.route).toBe('fallback-first')
    expect(state.lastUpdated).toBe(foreignUpdatedAt)
  })

  test('boot preserves fresh routing for an account added after plugin creation', async () => {
    const capturedStorage = createFallbackStorage({
      accounts: [],
      routing: { mode: 'fallback-first' },
    })
    expect(
      capturedStorage.accounts.some((account) => account.id === 'work-2'),
    ).toBe(false)
    await useTempAccountFile(capturedStorage)
    const plugin = await getPlugin()
    // An external settings write sets failClosedOnUnknownQuota=false and
    // adds an account. The existing plugin must reread both changes.
    await addPoolOAuthAccount('work-2', {
      access: 'sk-ant-oat01-work-2-access',
      refresh: 'work-2-refresh',
      expires: Date.now() + 100000,
    })
    await updatePoolSettings((settings) => ({
      ...settings,
      quota: {
        ...(settings.quota as Record<string, unknown>),
        failClosedOnUnknownQuota: false,
      },
    }))
    expect(
      (await readAccountStorage())?.accounts.some(
        (account) => account.id === 'work-2',
      ),
    ).toBe(true)
    await seedSidebarRouting('work-2', 'fallback-first', Date.now())

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-2')
    expect(state.route).toBe('fallback-first')
    expect(state.fallbacks.map((account) => account.id)).toContain('work-2')
    expect(resolveActiveAccount(state).id).toBe('work-2')
  })

  test('stale main routing write carries forward accounts added after plugin creation', async () => {
    const capturedStorage = createFallbackStorage({ accounts: [] })
    await useTempAccountFile(capturedStorage)
    const plugin = await getPlugin()
    // Add an account through another runtime to verify that an existing plugin rereads shared storage before selecting a fallback.
    await addPoolOAuthAccount('work-fresh', {
      access: 'sk-ant-oat01-work-fresh-access',
      refresh: 'work-fresh-refresh',
      expires: Date.now() + 100000,
    })
    await seedSidebarRouting('main', 'main', Date.now())

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('main')
    expect(state.route).toBe('main')
    expect(state.fallbacks.map((account) => account.id)).toContain('work-fresh')
  })

  test('stale writer does not resurrect a deleted active account', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: { enabled: false },
          accounts: [
            {
              id: 'work-deleted',
              type: 'oauth',
              access: 'sk-ant-oat01-work-deleted-access',
              refresh: 'work-deleted-refresh',
              expires: Date.now() - 1000,
            },
            {
              id: 'work-witness',
              type: 'oauth',
              access: 'sk-ant-oat01-work-witness-stale-access',
              refresh: 'work-witness-stale-refresh',
              expires: Date.now() - 1000,
              lastRefreshedAt: 100,
            },
          ],
        }),
      ),
    )
    const refreshStarted = bodyLifetime().gate()
    const releaseRefresh = bodyLifetime().gate()
    globalThis.fetch = mock((input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url === TOKEN_URL) {
        refreshStarted.open()
        return releaseRefresh.wait.then(
          () =>
            new Response(JSON.stringify({ error: 'invalid_grant' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }),
        )
      }
      if (url === PROFILE_URL) {
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      if (url === QUOTA_URL) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: { utilization: 0.1 },
              seven_day: { utilization: 0.1 },
              limits: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      return Promise.reject(new Error(`Unexpected test fetch: ${url}`))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const backgroundRefreshReady =
      getPluginTestHandles(plugin).fallbackRefreshReady
    expect(backgroundRefreshReady).toBeInstanceOf(Promise)
    try {
      await withDeadlockGuard(
        refreshStarted.wait,
        4_000,
        'fallback refresh never reached the token stub; the eager refresh did not start',
      )
      const pool = testContext.migratedPool
      if (!pool) throw new Error('Expected migrated pool')
      // Sign-in verifies the account behind each new access token; answer
      // that lookup from this map instead of the bootstrap endpoint.
      const signInIdentities = new Map<string, string>([
        [
          'sk-ant-oat01-work-current-access',
          '99999999-2222-4333-8444-555555555555',
        ],
      ])
      const peer = createNativeAccountRuntime({
        paths: pool.paths,
        host: 'opencode',
        local: {
          resolveIdentity: async (access) => {
            const identity = signInIdentities.get(access)
            if (!identity) throw new Error('Unknown synthetic sign-in token')
            return {
              deviceId: 'synthetic-device',
              sessionId: 'synthetic-session',
              accountUuid: identity as ProviderAccountUuid,
            }
          },
        },
      })
      try {
        const witness = (await peer.read()).accounts.find(
          (row) => row.id === 'work-witness',
        )
        if (!witness?.accountIdentity)
          throw new Error('Expected known witness UUID')
        signInIdentities.set(
          'sk-ant-oat01-work-witness-current-access',
          witness.accountIdentity,
        )
        const staleSubject = requireKnownPoolSubject(
          await peer.captureLocalSubject('work-deleted'),
        )
        // Removal shares the refresh lock, so queue it before releasing the
        // provider rather than waiting for removal while holding that lock.
        const removing = peer.remove('work-deleted')
        bodyLifetime().trackDetached(Promise.allSettled([removing]))
        releaseRefresh.open()
        await removing
        expect(
          await peer.publishLocal(staleSubject, { lastUsed: Date.now() }),
        ).toBe(false)
        await peer.loginOAuth({
          routeId: 'work-current',
          replace: false,
          credential: {
            access: 'sk-ant-oat01-work-current-access',
            refresh: 'work-current-refresh',
            expires: Date.now() + 100000,
          },
        })
        await peer.loginOAuth({
          routeId: 'work-witness',
          replace: true,
          credential: {
            access: 'sk-ant-oat01-work-witness-current-access',
            refresh: 'work-witness-current-refresh',
            expires: Date.now() - 1000,
          },
        })
        await peer.reorder(['main', 'work-current', 'work-witness'])
        const witnessFailure = await peer.authorizeLocal('work-witness', {
          intent: 'refresh',
        })
        expect(witnessFailure.status).toBe('failed')
      } finally {
        peer.close()
      }
      await seedSidebarRouting('work-deleted', 'fallback-first', Date.now())

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
      releaseRefresh.open()
      await withDeadlockGuard(
        backgroundRefreshReady!,
        4_000,
        'fallback background refresh did not complete after the token stub was released',
      )
      const disk = await readAccountStorage()
      expect(disk?.accounts.map((account) => account.id)).toEqual([
        'work-current',
        'work-witness',
      ])
      const poolRead = await createNativePoolStore({
        paths: pool.paths,
        quota: nativeQuotaCodec,
      }).read()
      expect(poolRead.status).toBe('ready')
      if (poolRead.status !== 'ready')
        throw new Error('Expected ready native pool')
      expect(
        poolRead.rows.find((row) => row.id === 'work-deleted'),
      ).toBeUndefined()
      expect(
        poolRead.rows.find((row) => row.id === 'work-current')?.credential,
      ).toMatchObject({
        access: 'sk-ant-oat01-work-current-access',
        refresh: 'work-current-refresh',
      })
      expect(
        disk?.accounts.find((account) => account.id === 'work-witness'),
      ).toMatchObject({
        lastRefreshError: { status: 400, permanent: true },
      })
      const state = await waitForSidebarState(
        (candidate) => candidate.activeId === 'work-current',
      )
      expect(state.route).toBe('fallback-first')
      expect(state.fallbacks.map((account) => account.id)).toEqual([
        'work-current',
        'work-witness',
      ])
    } finally {
      releaseRefresh.open()
    }
  })

  test('boot ignores stale sidebar routing and derives fallback-first routing', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    await seedSidebarRouting('main', 'main', Date.now() - 11 * 60 * 1000)

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('boot ignores fresh sidebar routing for an unknown account', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    await seedSidebarRouting('removed-account', 'fallback-first', Date.now())

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('boot keeps main-first sidebar routing on main', async () => {
    await useTempAccountFile(createFallbackStorage())

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
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('main')
    expect(state.route).toBe('main')
  })

  async function runQuotaRefreshWithFailedStorageReload(
    clearExistingRouting: boolean,
  ) {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ routing: { mode: 'fallback-first' } }),
      ),
    )
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
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
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(
      createMockClient(),
      testContext.tempConfigDir,
    )
    const loaded = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    // Establish the plugin's actual route before testing a quota-only write.
    const response = await loaded.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    await getPluginTestHandles(plugin).fallbackRefreshReady
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).toBe('fallback-1')
    if (clearExistingRouting) {
      const current = await getSidebarState()
      await setSidebarState({
        ...current,
        activeId: undefined,
        route: 'main',
        lastUpdated: Date.now(),
      })
    } else {
      await seedSidebarRouting('fallback-1', 'fallback-first', Date.now())
    }

    let signalBlocked!: () => void
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve
    })
    let releaseWrite!: () => void
    const released = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let shouldBlock = true
    __setSidebarStateWriteTestHooks({
      beforeRename: async () => {
        if (!shouldBlock) return
        shouldBlock = false
        signalBlocked()
        await released
      },
    })

    const blockingWrite = setSidebarState(await getSidebarState())
    await blocked
    try {
      const refreshed = await applyMenuAction(plugin, 'session-1', {
        sectionId: 'Quota',
        actionId: 'quota-refresh',
      })
      expect(refreshed.ok).toBe(true)
      // Quota polls return before publishing to the pool config. Drain those
      // writes so a pending rename cannot recreate the file during the swap.
      await getPluginTestHandles(plugin).scopedRuntime.drainQuotaPublications()
      // Replace the shared pool config JSON file with a directory so later
      // account reads fail instead of returning an outdated snapshot.
      const accountFile = testContext.migratedPool?.paths.config
      if (!accountFile) throw new Error('Expected a migrated pool')
      await rm(accountFile)
      await mkdir(accountFile)
    } finally {
      releaseWrite()
    }
    await blockingWrite
    await drainSidebarWrites()
    __setSidebarStateWriteTestHooks(null)
    return getSidebarState()
  }

  test('quota refresh preserves existing fallback routing when storage reload fails', async () => {
    const state = await runQuotaRefreshWithFailedStorageReload(false)
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('quota refresh uses supplied routing when storage reload fails without existing routing', async () => {
    const state = await runQuotaRefreshWithFailedStorageReload(true)
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('/claude-quota preserves the last sidebar routing decision', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
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
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

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

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-1')
    expect(state.route).toBe('fallback-first')
  })

  test('/claude-quota preserves fresher routing from another session', async () => {
    const releaseStartupQuota = bodyLifetime().gate()
    const startupSidebarMerged = bodyLifetime().gate()
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: Date.now() + 100000,
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-b-access',
            refresh: 'fallback-b-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return releaseStartupQuota.wait.then(
          () =>
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

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
    await seedSidebarRouting('fallback-b', 'fallback-first', Date.now())

    // The startup fallback-quota sweep publishes routing independently of menu
    // opening. Let its display-only merge learn the sibling's fresh route before
    // aging the file; draining alone cannot join a write not yet enqueued.
    __setSidebarStateWriteTestHooks({
      afterMergeRead: () => startupSidebarMerged.open(),
    })
    releaseStartupQuota.open()
    await startupSidebarMerged.wait
    await drainSidebarWrites()
    __setSidebarStateWriteTestHooks(null)

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('fallback-b')
    expect(state.route).toBe('fallback-first')

    await seedSidebarRouting(
      'fallback-b',
      'fallback-first',
      Date.now() - 11 * 60 * 1000,
    )
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await drainSidebarWrites()

    const stateAfterStaleFile = await getSidebarState()
    expect(stateAfterStaleFile.activeId).toBe('fallback-b')
    expect(stateAfterStaleFile.route).toBe('fallback-first')
  })

  test('real routing decisions overwrite fresh routing from another session', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: { enabled: false },
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'sk-ant-oat01-work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
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
    await seedSidebarRouting('work-alt', 'fallback-first', Date.now())

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('main')
    expect(state.route).toBe('main')
  })

  test('pool quota fixture waits for the other runtime to commit', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(new Response(null, { status: 200 })),
      ),
    ) as unknown as typeof fetch

    const committing = bodyLifetime().gate()
    const allowCommit = bodyLifetime().gate()
    let returned = false
    const publication = publishPoolMetadataWithCtx(
      testContext,
      'main',
      (identity) => ({
        quota: {
          accountIdentity: identity,
          seven_day: {
            usedPercent: 2,
            remainingPercent: 98,
            checkedAt: Date.now(),
          },
          checkedAt: Date.now(),
        },
      }),
      {
        beforePoolWrite: async () => {
          committing.open()
          await allowCommit.wait
        },
      },
    ).then(() => {
      returned = true
    })
    bodyLifetime().trackDetached(publication)

    await Promise.race([committing.wait, publication])
    try {
      // Hold the real quota commit, not the publication's in-memory overlay.
      expect(returned).toBe(false)
      const before = await readAccountStorage()
      expect(before?.quota?.mainQuota?.seven_day).toBeUndefined()
    } finally {
      allowCommit.open()
    }
    await publication

    const committed = await readAccountStorage()
    expect(committed?.quota?.mainQuota?.seven_day?.usedPercent).toBe(2)
  })

  test('sidebar shows persisted main quota written after plugin startup', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
        },
      }),
    )

    const plugin = await getPlugin()
    const storage = await readAccountStorage()
    expect(storage).not.toBeNull()

    let quotaApiCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) quotaApiCalls++
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch
    // Another OpenCode process records the main account's quota after this
    // plugin has started.
    await publishPoolQuota('main', {
      five_hour: {
        usedPercent: 12,
        remainingPercent: 88,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 2,
        remainingPercent: 98,
        checkedAt: Date.now(),
      },
      checkedAt: Date.now(),
    })
    await waitForNativePoolQuota(
      testContext,
      'main',
      (quota) => quota?.seven_day?.usedPercent === 2,
    )

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
    await drainSidebarWrites()

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const state = await getSidebarState()
    expect(state.main.quota?.seven_day?.usedPercent).toBe(2)
    expect(quotaApiCalls).toBe(0)
  })

  test('sidebar state records the actual fallback-first route', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({ routing: { mode: 'fallback-first' } }),
      ),
    )
    if (!testContext.migratedPool)
      throw new Error('Sidebar fixture did not migrate')
    const fixtureRuntime = createNativeAccountRuntime({
      paths: testContext.migratedPool.paths,
      host: 'opencode',
    })
    try {
      expect(
        (await fixtureRuntime.read()).accounts.find(
          (row) => row.id === 'fallback-1',
        )?.quota?.five_hour?.usedPercent,
      ).toBe(25)
    } finally {
      fixtureRuntime.close()
    }

    const authorizations: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
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

        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
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

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    await drainSidebarWrites()

    const state = await waitForSidebarState(
      (candidate) =>
        candidate.activeId === 'fallback-1' &&
        candidate.route === 'fallback-first' &&
        candidate.fallbacks[0]?.quota?.five_hour?.usedPercent === 25,
    )
    expect(state.route).toBe('fallback-first')
    expect(state.fallbacks[0]?.quota?.five_hour?.usedPercent).toBe(25)
    expect(authorizations[0]).toBe('Bearer sk-ant-oat01-fallback-access')
  })

  test('sidebar refresh reads metadata without authorizing expired main credentials', async () => {
    const main = { ...syntheticMainHostAuth(), expires: Date.now() - 1_000 }
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: false },
      }),
      main,
    )
    const requests: string[] = []
    globalThis.fetch = Object.assign(
      mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(extractUrl(input))
        return (await nativeAdmissionAnswer(input, init)) ?? Response.json({})
      }),
      { preconnect: globalThis.fetch.preconnect },
    )
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...main }),
      { models: {} },
    )
    const display =
      await getPluginTestHandles(plugin).resolveSidebarQuotaAccess()
    expect(display.storage?.quota?.enabled).toBe(false)
    expect(display.access).toBeUndefined()
    expect(requests).toEqual([])
  })

  test('background fallback refresh updates the sidebar without a request', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          accounts: [
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                // Plugin startup polls this OAuth account's usage because its saved reading is old.
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: 1,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: 1,
                },
              },
            },
          ],
        }),
      ),
    )

    const usageAuthorizations: Array<string | null> = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (extractUrl(input).includes('/api/oauth/usage')) {
            usageAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization: 0.42 },
                  seven_day: { utilization: 0.1 },
                }),
                { status: 200 },
              ),
            )
          }
          return Promise.resolve(new Response('ok', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    // Running the loader starts the background refresh (immediate first pass).
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

    await getPluginTestHandles(plugin).fallbackRefreshReady
    expect(usageAuthorizations).toContain('Bearer sk-ant-oat01-fallback-access')
    expect(
      (await readNativeRuntimeState()).accounts['fallback-1']?.quota?.five_hour
        ?.usedPercent,
    ).toBe(0.42)
    // The background pass refreshes the stale fallback and the hook re-writes the
    // sidebar — without any request to the messages endpoint.
    // utilization: 0.42 → usedPercent: 0.42 (stored as-is, not multiplied by 100)
    const state = await waitForSidebarState(
      (candidate) =>
        candidate.fallbacks[0]?.quota?.five_hour?.usedPercent === 0.42,
    )
    expect(state.fallbacks[0]?.id).toBe('fallback-1')
  })
})
