import {
  afterAll,
  afterEach,
  beforeEach,
  test as bunTest,
  describe,
  expect,
  mock,
  spyOn,
} from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  NativeRefreshSubject,
  PrimeManager,
} from '@cortexkit/anthropic-auth-core'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  type AccountStorage,
  buildPrimeRequestBody,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  type CommandApplyRequest,
  type CommandApplyResult,
  CustodyTombstoneRefreshError,
  createNativeAccountRuntime,
  createNativePoolStore,
  custodyTombstoneOAuth,
  extractBillingHeaderCCH,
  FallbackAccountManager,
  getAccountStatePath,
  getClaudeCodeIdentityForVerifiedAccount,
  getDumpDirectory,
  hashRefreshToken,
  isCustodyTombstoneOAuth,
  isDumpEnabled,
  isNativeLocalCredentialValidation,
  isOAuthAccount,
  type LogTestRecord,
  loadAccounts,
  type NativeCustodyClient,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  PROFILE_TTL_MS,
  type ProviderAccountUuid,
  resetCache1hState,
  resetClaudeCodeIdentityCachesForTest,
  resetDumpState,
  resetFastModeState,
  saveAccountState,
  saveAccounts,
  setLogLevel,
  TRAILING_ASSISTANT_HISTORY_MESSAGE,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { withLock } from '@cortexkit/common-auth/fs'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import { EFFORT_MARKER_PREFIX } from '../effort-history'
import { AnthropicAuthPlugin } from '../index'
import { LANE_START_REQUEST_HEADER, LANE_START_TEXT } from '../lane-start'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol'
import { createRpcClient } from '../rpc/rpc-client'
import {
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
} from '../server-fallback'
import {
  __setInitialSidebarRoutingTestHooks,
  __setSidebarStateWriteTestHooks,
  drainSidebarWrites,
  getSidebarState,
  getSidebarStateFile,
  resolveActiveAccount,
  setSidebarState,
} from '../sidebar-state'
import { rewriteRequestBody } from '../transform.ts'
import {
  migrateNativeOpencodeFixture,
  type NativeOpencodeFixture,
} from './native-fixture.ts'
import {
  extractUrl,
  installDefaultFetchMock,
  MESSAGES_URL,
  PROFILE_URL,
  QUOTA_URL,
  TOKEN_URL,
} from './test-fetch'

async function freshPrimeQuotaResponse(
  body: unknown,
  init: ResponseInit = { status: 200 },
): Promise<Response> {
  await Bun.sleep(2)
  return new Response(JSON.stringify(body), init)
}

// Minimal mock of the OpenCode plugin client
function createMockClient(
  messages?: unknown[],
  getSessionStatuses?: () =>
    | Record<string, { type: string }>
    | Promise<Record<string, { type: string }>>,
) {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
    session: {
      messages: messages
        ? mock(() => Promise.resolve({ data: messages }))
        : undefined,
      status: getSessionStatuses
        ? mock(async () => ({ data: await getSessionStatuses() }))
        : undefined,
      promptAsync: mock((_input: unknown) => Promise.resolve()),
    },
  }
}

const EMPTY_POST = { method: 'POST', body: '{}' } as const
let tempConfigDir: string | undefined
const tempConfigDirs = new Set<string>()
const allTempConfigDirs = new Set<string>()
const fallbackRefreshes = new Set<Promise<unknown>>()

// Environment variables a test sets to point the plugin at its migrated
// account pool; each test's cleanup puts back their previous values.
const nativeEnvKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_AUTH_CONTENT',
] as const

/**
 * One lifetime per test. It is created before the describe-level beforeEach
 * hooks run, so a pool migrated in a hook and one migrated in the body share
 * it. Teardown waits for the whole body and registered work, disposes the
 * plugins it created, then removes the directories it migrated.
 */
let testLifetime: TestLifetime | undefined
/** The pool the current test migrated most recently, if any. */
let migratedPool: MigratedPool | undefined
const livePlugins = new Set<{ dispose?: () => unknown }>()

type MigratedPool = NativeOpencodeFixture & {
  /** The Anthropic OAuth credential transferred from OpenCode's auth.json to the shared credential pool. */
  mainHostAuth: { access: string; refresh: string; expires: number }
}

function bodyLifetime(): TestLifetime {
  if (!testLifetime) throw new Error('Test fixture has no body lifetime')
  return testLifetime
}

type TestBody = () => unknown

async function drainBeforeReset(
  lifetime: TestLifetime | undefined,
  reset: () => void | Promise<void>,
) {
  // Bun can time out the test before its async body finishes. Keep its
  // transport and environment intact until that body and its work drain.
  await lifetime?.finish()
  await reset()
}

/** Bun's test, with the body run inside this test's fixture lifetime. */
function test(name: string, body: TestBody, timeout?: number) {
  bunTest(name, () => bodyLifetime().runBody(body), timeout)
}
test.serial = (name: string, body: TestBody, timeout?: number) => {
  bunTest.serial(name, () => bodyLifetime().runBody(body), timeout)
}
test.each =
  <T>(cases: readonly T[]) =>
  (name: string, body: (row: T) => unknown, timeout?: number) => {
    bunTest.each(cases as T[])(
      name,
      (row: T) => bodyLifetime().runBody(() => body(row)),
      timeout,
    )
  }

beforeEach(() => {
  installDefaultFetchMock()
  const lifetime = new TestLifetime()
  testLifetime = lifetime
  const savedEnv = new Map(
    nativeEnvKeys.map((key) => [key, process.env[key]] as const),
  )
  // Registered first, so it runs before any migrated directory is removed:
  // plugins stop and pending sidebar writes land while their files exist.
  lifetime.deferCleanup(async () => {
    const plugins = [...livePlugins]
    livePlugins.clear()
    const results = await Promise.allSettled(
      plugins.map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
    )
    try {
      await drainSidebarWrites()
    } finally {
      migratedPool = undefined
      poolLogins.length = 0
      successorAccess.clear()
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Plugin disposal failed',
      )
  })
})

afterEach(async () => {
  const lifetime = testLifetime
  testLifetime = undefined
  try {
    await cleanupTempConfigDirs()
  } finally {
    await lifetime?.finish()
  }
})

afterAll(async () => {
  await cleanupTempConfigDirs()
  await Bun.sleep(100)
  await cleanupTempConfigDirs()
  await Promise.all(
    [...allTempConfigDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => {}),
    ),
  )
  allTempConfigDirs.clear()
})

async function cleanupTempConfigDirs(drainTimeoutMs = 4_000) {
  const refreshesSettled = await Promise.race([
    Promise.allSettled(fallbackRefreshes).then(() => true),
    Bun.sleep(drainTimeoutMs).then(() => false),
  ])
  if (refreshesSettled) fallbackRefreshes.clear()
  await drainSidebarWrites()
  // tempConfigDir is a migrated root; the test's lifetime removes it after
  // disposing the plugins that use it.
  const directories = [...tempConfigDirs]
  tempConfigDirs.clear()
  tempConfigDir = undefined
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => {}),
    ),
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

/**
 * A signal a test's mock raises when the plugin reaches a point the body
 * waits for. Teardown raises it as well, so a body still waiting for a point
 * the plugin never reached resumes and finishes (failing on its assertions)
 * instead of holding its plugin and every later test's teardown.
 */
function lifetimeSignal() {
  const gate = bodyLifetime().gate()
  return { raised: gate.wait, raise: gate.open }
}

/**
 * A provider response the test releases when it chooses. If the test ends
 * first, teardown rejects it with an AbortError, so plugin work waiting on
 * this response settles before the plugin is disposed and its files removed.
 */
function heldResponse() {
  const released = bodyLifetime().gate()
  let response: Response | undefined
  const held = released.wait.then(
    () =>
      response ??
      Promise.reject(
        new DOMException(
          'The test ended before releasing this response',
          'AbortError',
        ),
      ),
  )
  // A test that fails before its mock hands this response to the plugin
  // must not also report the teardown rejection as an unhandled error.
  held.catch(() => {})
  return {
    response: held,
    release(value: Response) {
      response = value
      released.open()
    },
  }
}

async function withDeadlockGuard<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = timers.setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) timers.clearTimeout(timeout)
  }
}

test('withDeadlockGuard clears its timeout after the primary settles', async () => {
  // Count only the timer injected into this guard so concurrent suites cannot
  // affect the probe.
  const sentinelDelayMs = 47
  const guardTimers = new Set<unknown>()
  let timeoutFired = 0
  let timeoutCleared = 0
  let unhandled = 0
  const guardMessage = 'late guard'
  const onUnhandled = (reason: unknown) => {
    if (reason instanceof Error && reason.message === guardMessage) {
      unhandled += 1
    }
  }
  const setTimeoutImpl = ((
    callback: (...args: any[]) => void,
    delay?: number,
  ) => {
    const isGuardTimer = delay === sentinelDelayMs
    const handle = globalThis.setTimeout(() => {
      if (isGuardTimer) timeoutFired += 1
      callback()
    }, delay)
    if (isGuardTimer) guardTimers.add(handle)
    return handle
  }) as typeof globalThis.setTimeout
  const clearTimeoutImpl = ((
    timeout: ReturnType<typeof globalThis.setTimeout>,
  ) => {
    if (guardTimers.delete(timeout)) timeoutCleared += 1
    globalThis.clearTimeout(timeout)
  }) as typeof globalThis.clearTimeout
  process.on('unhandledRejection', onUnhandled)
  try {
    await withDeadlockGuard(
      Promise.resolve('primary'),
      sentinelDelayMs,
      guardMessage,
      { setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl },
    )
    await Bun.sleep(100)
    expect(timeoutFired).toBe(0)
    expect(timeoutCleared).toBe(1)
    expect(unhandled).toBe(0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('withDeadlockGuard rejects with its message at the deadline', async () => {
  await expect(
    withDeadlockGuard(new Promise<never>(() => {}), 20, 'deadline'),
  ).rejects.toThrow('deadline')
})

test('cleanup retries a fallback refresh that outlives its bounded wait', async () => {
  const slowRefresh = deferred()
  let settled = false
  const refresh = slowRefresh.promise.then(() => {
    settled = true
  })
  fallbackRefreshes.add(refresh)

  const firstStartedAt = Date.now()
  await cleanupTempConfigDirs(50)
  expect(Date.now() - firstStartedAt).toBeLessThan(500)
  expect(settled).toBe(false)
  expect(fallbackRefreshes.has(refresh)).toBe(true)

  const releaseTimer = setTimeout(() => slowRefresh.resolve(), 20)
  try {
    await cleanupTempConfigDirs(50)
  } finally {
    clearTimeout(releaseTimer)
  }
  expect(settled).toBe(true)
  expect(fallbackRefreshes.size).toBe(0)
})

test('extractUrl uses canonical fetch URLs and preserves raw invalid strings', () => {
  expect(extractUrl('https://example.com/a/../b')).toBe('https://example.com/b')
  expect(extractUrl('/relative')).toBe('/relative')
  expect(extractUrl('not a URL')).toBe('not a URL')
})

async function expectHandledCommandResponse(promise: Promise<unknown>) {
  try {
    await promise
    throw new Error('Expected handled command sentinel')
  } catch (error) {
    expect(String(error)).toContain(
      '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__',
    )
    const value = error as Record<string, unknown>
    expect(value['~effect/http/HttpServerResponse']).toBe(
      '~effect/http/HttpServerResponse',
    )
    expect(value['~effect/ErrorReporter/ignore']).toBe(true)
    expect(value.status).toBe(204)
    expect((value.body as { _tag?: unknown })?._tag).toBe('Empty')
    expect((value.cookies as { cookies?: unknown })?.cookies).toEqual({})
  }
}

function createFallbackStorage(
  overrides?: Partial<AccountStorage>,
): AccountStorage {
  return {
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
    accounts: [
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
    ...overrides,
  }
}

/** Default Anthropic account UUID for the main OAuth credential in these fixtures. */
const syntheticMainAccountUuid =
  '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid

/**
 * Record in a legacy store which Claude account the main login belongs to: a
 * main profile observed for that login's access token. Migration then gives
 * the pool's main login a known account, which the native runtime confirms
 * with bootstrap alone instead of first exchanging the refresh token.
 */
function bindMainAccount(
  storage: AccountStorage,
  access = 'sk-ant-oat01-main-access',
  identity: ProviderAccountUuid = syntheticMainAccountUuid,
): AccountStorage {
  storage.main = {
    type: 'opencode',
    provider: 'anthropic',
    ...storage.main,
    profile: {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: Date.now(),
      ...storage.main?.profile,
      providerAccountUuid: identity,
      tokenFingerprint: tokenFingerprint(access),
    },
  }
  return storage
}

/**
 * Name the Claude account behind a legacy store's main quota snapshot, the
 * only form of it that migration imports. Migration keeps a main quota only
 * when the store recorded which account produced it: a main profile observed
 * for the migrated access token, and a snapshot carrying that account. A
 * snapshot keyed by nothing or by the slot label "main" is dropped, and
 * quota-based routing then waits for a fresh snapshot instead.
 */
function bindMainQuotaToAccount(
  storage: AccountStorage,
  access = 'sk-ant-oat01-main-access',
  identity: ProviderAccountUuid = syntheticMainAccountUuid,
): AccountStorage {
  const quota = storage.quota?.mainQuota
  if (!storage.quota || !quota)
    throw new Error('This store has no main quota to bind')
  bindMainAccount(storage, access, identity)
  storage.quota.mainQuota = { ...quota, accountIdentity: identity }
  storage.quota.mainQuotaToken = tokenFingerprint(access)
  return storage
}

/** The Claude account a synthetic fallback login at `index` belongs to. */
function syntheticFallbackAccountUuid(index: number) {
  return `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}` as ProviderAccountUuid
}

/**
 * Give a legacy store the account identities migration needs to carry its
 * quota into the native pool: the main login's account (see
 * bindMainQuotaToAccount, or bindMainAccount when there is no main quota),
 * and a Claude account UUID for each OAuth fallback that has none. Quota
 * snapshots and errors a fallback recorded under its slot id, or under no
 * account, are re-keyed to that UUID, as the legacy writer would have keyed
 * them had it known the account.
 */
function bindPoolAccounts(
  storage: AccountStorage,
  access = 'sk-ant-oat01-main-access',
): AccountStorage {
  if (storage.quota?.mainQuota) bindMainQuotaToAccount(storage, access)
  else bindMainAccount(storage, access)
  storage.accounts.forEach((account, index) => {
    if (account.type !== 'oauth') return
    const uuid =
      account.anthropicAccountUuid ?? syntheticFallbackAccountUuid(index)
    account.anthropicAccountUuid = uuid
    const rebind = <T extends { accountIdentity?: string }>(value: T) =>
      value.accountIdentity === undefined ||
      value.accountIdentity === account.id
        ? { ...value, accountIdentity: uuid }
        : value
    if (account.quota) account.quota = rebind(account.quota)
    if (account.lastRefreshError)
      account.lastRefreshError = rebind(account.lastRefreshError)
    if (account.lastQuotaRefreshError)
      account.lastQuotaRefreshError = rebind(account.lastQuotaRefreshError)
  })
  return storage
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
  const pool = migratedPool
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

async function expectUnknownQuotaAdmissionBlocked(storage: AccountStorage) {
  const now = Date.now()
  storage.quota = {
    ...storage.quota,
    mainLastQuotaApiError: {
      message: 'quota source unavailable',
      checkedAt: now,
      nextRetryAt: now + 60_000,
      retryCount: 1,
    },
  }
  // Import the configured usage-API failure into shared account storage.
  // Migration retires the old state file; later writes use shared storage.
  await useTempAccountFile(storage)
  globalThis.fetch = mock(
    withNativeAdmission((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage'))
        return Promise.reject(new Error('quota source unavailable'))
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
}

/**
 * Main OAuth credential stored in the fixture's OpenCode auth.json.
 * The Anthropic OAuth access-token prefix enables the bootstrap request that
 * verifies its account UUID. Arbitrary token strings must not gain access.
 */
function syntheticMainHostAuth() {
  return {
    access: 'sk-ant-oat01-main-access',
    refresh: 'main-refresh',
    expires: Date.now() + 8 * 60 * 60_000,
  }
}

/**
 * Serialize old-installation data with saveAccounts and saveAccountState.
 * Return the config and credential-state text for offline migration.
 */
async function legacyAccountFiles(storage: AccountStorage) {
  const scratch = await mkdtemp(join(tmpdir(), 'anthropic-plugin-legacy-'))
  const configPath = join(scratch, 'anthropic-auth.json')
  const statePath = join(scratch, 'anthropic-auth-state.json')
  const savedStatePath = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = statePath
  try {
    await saveAccounts(storage, configPath)
    if (
      storage.main?.profile ||
      storage.prime?.mainAuthLineageId ||
      storage.prime?.main
    )
      await saveAccountState(storage, configPath, {
        mainProfile: Boolean(storage.main?.profile),
        mainPrime: Boolean(
          storage.prime?.mainAuthLineageId || storage.prime?.main,
        ),
      })
    return {
      config: await readFile(configPath, 'utf8'),
      state: await readFile(statePath, 'utf8').catch(() => undefined),
    }
  } finally {
    if (savedStatePath === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
    else process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = savedStatePath
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Run offline migration to transfer the fixture's old account files and
 * OpenCode OAuth credential into shared storage. Construct plugins afterwards
 * so their startup reads see the committed authority journal and pool.
 */
async function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth = syntheticMainHostAuth(),
) {
  const lifetime = bodyLifetime()
  const root = await mkdtemp(join(tmpdir(), 'anthropic-plugin-test-'))
  // Register removal before migration can reject the directory. Cleanup
  // otherwise would not know about a directory created by failed setup.
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const legacy = await legacyAccountFiles(storage)
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime,
    legacyConfig: legacy.config,
    ...(legacy.state !== undefined && { legacyState: legacy.state }),
    hostAuth: { anthropic: { type: 'oauth', ...mainHostAuth } },
  })
  migratedPool = { ...fixture, mainHostAuth }
  registerPoolLogins(storage, mainHostAuth)
  // TestLifetime removes this directory after disposing its plugin instances
  // and joining their asynchronous work.
  tempConfigDir = fixture.root
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  delete process.env.OPENCODE_AUTH_CONTENT
}

/**
 * Credentials and account UUIDs accepted by this test's OAuth server mocks.
 * Unknown credentials must not receive a successful bootstrap or exchange.
 */
type PoolLogin = { access: string; refresh: string; identity: string }
const poolLogins: PoolLogin[] = []

function registerPoolLogins(
  storage: AccountStorage,
  main: { access: string; refresh: string },
) {
  poolLogins.length = 0
  successorAccess.clear()
  const identityFor = (index: number) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  // Migration learns the main account UUID from its token-bound profile.
  // The bootstrap mock must return that same UUID for the migrated credential.
  poolLogins.push({
    ...main,
    identity: storage.main?.profile?.providerAccountUuid ?? identityFor(0),
  })
  storage.accounts.forEach((account, index) => {
    if (account.type !== 'oauth' || !account.access || !account.refresh) return
    poolLogins.push({
      access: account.access,
      refresh: account.refresh,
      identity: account.anthropicAccountUuid ?? identityFor(index + 1),
    })
  })
}

async function requestText(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === 'string') return init.body
  return input instanceof Request ? input.clone().text() : ''
}

/**
 * Synthetic Anthropic OAuth answers a migrated pool needs before it serves.
 * The native runtime checks the account behind a local OAuth login before
 * serving it. When the pool does not yet know that account, it exchanges the
 * login's refresh token first and reads the account of the new access token
 * (bootstrap); when it does, bootstrap alone confirms it. For a login this
 * test migrated, the token endpoint returns the same access and refresh tokens
 * with a fresh expiry, and bootstrap names the login's account; every other
 * request is left to the test's own mock.
 */
async function nativeAdmissionAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response | undefined> {
  return (
    (await nativeTokenAnswer(input, init)) ??
    (await nativeBootstrapAnswer(input, init))
  )
}

/** The token-endpoint half of nativeAdmissionAnswer. */
async function nativeTokenAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins: readonly PoolLogin[] = poolLogins,
): Promise<Response | undefined> {
  if (!extractUrl(input).includes('/v1/oauth/token')) return undefined
  let refresh: unknown
  try {
    refresh = JSON.parse(await requestText(input, init)).refresh_token
  } catch {
    return undefined
  }
  const login = logins.find((entry) => entry.refresh === refresh)
  if (!login) return undefined
  return Response.json({
    access_token: login.access,
    refresh_token: login.refresh,
    expires_in: 8 * 60 * 60,
  })
}

/**
 * Like withNativeAdmission, but for a test whose own mock answers bootstrap
 * (it checks which account bootstrap reports): only the token endpoint is
 * answered here.
 */
function withNativeTokenExchange<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
): (input: Input, init: Init) => Promise<unknown> {
  return async (input, init) =>
    (await nativeTokenAnswer(
      input as Parameters<typeof fetch>[0],
      init as RequestInit | undefined,
    )) ?? handler(input, init)
}

/**
 * Later access tokens of an account already in this test's pool, mapped to
 * that account: tokens the test's own token endpoint issues on refresh, or a
 * re-login of the same account. The native runtime reads the account behind
 * every new access token before it serves it, so bootstrap must name the
 * same account for these as for the login they replace.
 */
const successorAccess = new Map<string, string>()

/** The Claude account the main login of this test's pool belongs to. */
function poolMainIdentity(): string {
  const main = poolLogins[0]
  if (!main) throw new Error('This test has no migrated local main login')
  return main.identity
}

/** Record that `accesses` are later tokens of the pool's main account. */
function mainAccountIssues(...accesses: string[]) {
  const identity = poolMainIdentity()
  for (const access of accesses) successorAccess.set(access, identity)
}

/**
 * Record that `accesses` are later tokens of the account whose migrated
 * login has the access token `current`.
 */
function loginIssues(current: string, ...accesses: string[]) {
  const login = poolLogins.find((entry) => entry.access === current)
  if (!login) throw new Error(`No migrated login has access token ${current}`)
  for (const access of accesses) successorAccess.set(access, login.identity)
}

/**
 * Bootstrap's answer for an access token of this test's pool, or for a
 * later token of one of its accounts; undefined for anything else, which the
 * test's own mock then answers.
 */
async function nativeBootstrapAnswer(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins: readonly PoolLogin[] = poolLogins,
): Promise<Response | undefined> {
  if (!extractUrl(input).includes('/api/claude_cli/bootstrap')) return undefined
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  const bearer = headers.get('authorization')?.replace(/^Bearer /, '')
  const known = new Set(logins.map((entry) => entry.identity))
  const successor =
    bearer === undefined ? undefined : successorAccess.get(bearer)
  const identity =
    logins.find((entry) => entry.access === bearer)?.identity ??
    (successor !== undefined && known.has(successor) ? successor : undefined)
  if (!identity) return undefined
  return Response.json({ oauth_account: { account_uuid: identity } })
}

function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
): (input: Input, init: Init) => Promise<unknown> {
  return async (input, init) =>
    (await nativeAdmissionAnswer(
      input as Parameters<typeof fetch>[0],
      init as RequestInit | undefined,
    )) ?? handler(input, init)
}

/**
 * Answer exchange and bootstrap requests for the primary account only.
 * Let the test's handler control these endpoints for its fallback accounts.
 */
function withMainAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
): (input: Input, init: Init) => Promise<unknown> {
  return async (input, init) => {
    const main = poolLogins.slice(0, 1)
    const request = input as Parameters<typeof fetch>[0]
    const options = init as RequestInit | undefined
    return (
      (await nativeTokenAnswer(request, options, main)) ??
      (await nativeBootstrapAnswer(request, options, main)) ??
      handler(input, init)
    )
  }
}

/**
 * Answer account-bootstrap requests, but leave OAuth exchange requests to
 * the test's handler so it can count refreshes or return rotated tokens.
 */
function withNativeBootstrap<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
): (input: Input, init: Init) => Promise<unknown> {
  return async (input, init) =>
    (await nativeBootstrapAnswer(
      input as Parameters<typeof fetch>[0],
      init as RequestInit | undefined,
    )) ?? handler(input, init)
}

/**
 * Replace the primary OAuth credential through a separate account runtime.
 * With sameAccount=true, register the new access token under the existing
 * account UUID; otherwise the test supplies its own bootstrap response.
 * accountIdentity supplies an already known UUID; token validation still
 * runs before serving. The plugin discovers the change from shared storage.
 */
async function replacePoolMainLogin(
  credential: { access: string; refresh: string; expires: number },
  options: { sameAccount: boolean; accountIdentity?: string } = {
    sameAccount: true,
  },
) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  if (options.sameAccount) {
    mainAccountIssues(credential.access)
    poolLogins.push({ ...credential, identity: poolMainIdentity() })
  }
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.loginOAuth({
      routeId: 'main',
      replace: true,
      credential,
      ...(options.accountIdentity
        ? { accountIdentity: options.accountIdentity }
        : {}),
    })
  } finally {
    runtime.close()
  }
}

/** Require all stored fields that a known-account publication must carry. */
function requireKnownPoolSubject(
  subject: NativeRefreshSubject,
): Parameters<
  ReturnType<typeof createNativeAccountRuntime>['publishLocal']
>[0] {
  const { binding, credentialFingerprint, version } = subject
  if (
    !binding.identity ||
    !credentialFingerprint ||
    !version?.accessFingerprint ||
    version.expires === undefined
  )
    throw new Error('Expected a complete known pool credential subject')
  return {
    binding: { ...binding, identity: binding.identity },
    credentialFingerprint,
    version: {
      ...version,
      accessFingerprint: version.accessFingerprint,
      expires: version.expires,
    },
  }
}

/**
 * Refresh the pool's main login in another plugin process; see
 * refreshPoolLoginElsewhere.
 */
async function refreshPoolMainElsewhere(successor: {
  access: string
  refresh: string
  expires: number
}) {
  mainAccountIssues(successor.access)
  await refreshPoolLoginElsewhere('main', successor)
}

/**
 * Rotate the chosen account's tokens using a separate account runtime.
 * Register the returned access token with loginIssues or mainAccountIssues
 * before calling this helper, so bootstrap confirms its account UUID.
 * The injected exchange returns successor directly; the tested plugin's
 * exchange mock must see no request for this externally completed rotation.
 */
async function refreshPoolLoginElsewhere(
  routeId: string,
  successor: { access: string; refresh: string; expires: number },
) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
    local: {
      refreshToken: async () => ({
        ...successor,
        expiresIn: Math.round((successor.expires - Date.now()) / 1000),
      }),
    },
  })
  try {
    const result = await runtime.authorizeLocal(routeId, { intent: 'refresh' })
    if (result.status !== 'usable' || result.access !== successor.access)
      throw new Error(
        `Refresh of ${routeId} elsewhere did not complete: ${result.status} ${'reason' in result ? result.reason : ''}`,
      )
  } finally {
    runtime.close()
  }
}

/**
 * Commit the caller's settings update using a separate account runtime.
 * The tested plugin must discover the change by rereading shared storage.
 */
async function updatePoolSettings(
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateSettings(mutator)
  } finally {
    runtime.close()
  }
}

/**
 * Add an alternative OAuth account through a separate account runtime.
 * Its tokens belong only in shared storage, never in OpenCode's auth.json.
 */
async function addPoolOAuthAccount(
  routeId: string,
  credential: { access: string; refresh: string; expires: number },
) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.loginOAuth({ routeId, credential, replace: false })
  } finally {
    runtime.close()
  }
}

/**
 * Commit relay configuration using the account runtime's updateRelay API.
 * This keeps the relay secret outside the public settings projection.
 */
async function updatePoolRelay(
  patch: Parameters<
    ReturnType<typeof createNativeAccountRuntime>['updateRelay']
  >[0],
) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateRelay(patch)
  } finally {
    runtime.close()
  }
}

/**
 * Publish a usage reading from a separate account runtime, tagged with the
 * account UUID verified for the credential that authorized the reading.
 */
function publishPoolQuota(routeId: string, quota: OAuthQuotaSnapshot) {
  return publishPoolMetadata(routeId, (identity) => ({
    quota: { ...quota, accountIdentity: identity },
  }))
}

/**
 * Authorize the account using a separate runtime, then publish quota or error
 * metadata for that exact credential version. A concurrent credential change
 * must make publication refuse rather than attach metadata to the new login.
 */
async function publishPoolMetadata(
  routeId: string,
  patch: (
    identity: string,
  ) => Parameters<
    ReturnType<typeof createNativeAccountRuntime>['publishLocal']
  >[1],
) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const authorization = await runtime.authorizeLocal(routeId)
    if (authorization.status !== 'usable')
      throw new Error(`Pool ${routeId} login is not usable`)
    const identity = authorization.binding.identity
    if (identity === undefined)
      throw new Error(`Pool ${routeId} login has no confirmed account`)
    const published = await runtime.publishLocal(
      authorization.subject,
      patch(identity),
    )
    if (!published) throw new Error(`Metadata for ${routeId} was not published`)
  } finally {
    runtime.close()
  }
}

/**
 * Check that OpenCode's auth store still holds only the placeholder login
 * migration wrote for Anthropic: no access or refresh token reached it.
 */
async function expectHostActivationNonSecret(...tokens: string[]) {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const text = await readFile(pool.hostAuthPath, 'utf8')
  expect(isCustodyTombstoneOAuth(JSON.parse(text).anthropic, 'anthropic')).toBe(
    true,
  )
  for (const token of tokens) expect(text).not.toContain(token)
}

/**
 * The access token the pool would hand a new caller for its main login, read
 * through a separate native runtime the way another plugin process would.
 */
async function poolMainAccess(): Promise<string> {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const result = await runtime.authorizeLocal('main')
    if (result.status !== 'usable')
      throw new Error(`Pool main login is not usable: ${result.status}`)
    return result.access
  } finally {
    runtime.close()
  }
}

/**
 * Return the non-secret activation marker written to OpenCode's auth.json.
 * Reject fixture credentials that differ from those imported by migration;
 * the host loader cannot supply an unrelated login as pool authority.
 */
async function migratedHostAuth(
  pool: MigratedPool,
  testAuth: () => Promise<Record<string, unknown>>,
) {
  const supplied = await testAuth()
  if (
    supplied.type !== 'oauth' ||
    isCustodyTombstoneOAuth(supplied, 'anthropic')
  )
    return supplied
  const migrated = pool.mainHostAuth
  if (
    supplied.access !== migrated.access ||
    supplied.refresh !== migrated.refresh ||
    (typeof supplied.expires === 'number' && supplied.expires <= Date.now()) !==
      migrated.expires <= Date.now()
  )
    throw new Error(
      `Test host OAuth ${String(supplied.access)} is not the login migrated into this pool (${migrated.access})`,
    )
  return JSON.parse(await readFile(pool.hostAuthPath, 'utf8')).anthropic
}

const syntheticMainIdentity = '11111111-1111-4111-8111-111111111111'

/** A synthetic vault whose listing holds only the main account's credential
 * row; any attempt to read that credential's token makes the test fail. */
function mainOnlyVault(): NativeCustodyClient {
  return {
    async listScoped() {
      return {
        view: 'synthetic-native-view',
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: syntheticMainIdentity,
            credentialType: 'oauth',
            state: 'active',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            providerIds: [],
            refreshAdapter: 'anthropic',
            recordVersion: 1,
            operations: ['read', 'invalidate'],
            createdAtMs: 1,
          },
        ],
      }
    },
    async getScoped() {
      throw new Error('Status tests must not read vault credential material')
    },
    async reportAuthFailureScoped() {
      throw new Error('Status tests must not report vault failures')
    },
    close() {},
  }
}

/**
 * Run setup migration for accounts whose credentials remain in Claustrum.
 * The fixture's enrollment token permits listing vault accounts for this host.
 * Plugin startup then reads the committed, credential-free account inventory.
 */
async function useVaultAccountFile(
  storage: AccountStorage,
  client: NativeCustodyClient,
) {
  const lifetime = bodyLifetime()
  const root = await mkdtemp(join(tmpdir(), 'anthropic-plugin-vault-'))
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const legacy = await legacyAccountFiles(storage)
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime,
    legacyConfig: legacy.config,
    ...(legacy.state !== undefined && { legacyState: legacy.state }),
    hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
    custody: {
      connect: async () => client,
      enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
    },
  })
  poolLogins.length = 0
  // In vault custody auth.json never held the main tokens; it already holds
  // the placeholder login, so there is no local main login to compare.
  migratedPool = {
    ...fixture,
    mainHostAuth: { access: '', refresh: '', expires: 0 },
  }
  tempConfigDir = fixture.root
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  delete process.env.OPENCODE_AUTH_CONTENT
  return fixture
}

/**
 * Keep the old account files without running migration. Tests can then
 * verify that plugin startup neither adopts their credentials nor rewrites them.
 */
async function useUnmigratedAccountFile(storage: AccountStorage) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-plugin-unmigrated-'))
  bodyLifetime().deferCleanup(() => rm(root, { recursive: true, force: true }))
  migratedPool = undefined
  poolLogins.length = 0
  tempConfigDir = root
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(root, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    root,
    'anthropic-auth-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    root,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    root,
    'opencode-enrollment.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    root,
    'missing-connection.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    root,
    'cachekeep-registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    root,
    'quota-header-feed',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(root, 'rpc')
  await saveAccounts(storage)
}

// The fetch installed by the test preload (setup.ts), which only allows
// 127.0.0.1 requests; captured before any test mock replaces it.
const loopbackFetch = globalThis.fetch

/**
 * Records without Anthropic's sk-ant-oat access-token prefix must refuse
 * before sending a model request, even if bootstrap supplies an account UUID.
 * The error directs API-key users to OpenCode's stock Anthropic authentication.
 */
async function expectNonOatMainRefused(access: string) {
  await useTempAccountFile(
    createFallbackStorage({ accounts: [], quotaHeaderFeed: { enabled: true } }),
    { access, refresh: `refresh-${access}`, expires: Date.now() + 100_000 },
  )
  const modelRequests: string[] = []
  globalThis.fetch = mock(
    withNativeTokenExchange((input: Parameters<typeof fetch>[0]) => {
      const url = extractUrl(input)
      if (url.includes('/claude_cli/bootstrap'))
        return Promise.resolve(
          Response.json({
            oauth_account: { account_uuid: syntheticMainAccountUuid },
          }),
        )
      if (url.includes('/v1/messages')) modelRequests.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }),
  ) as unknown as typeof fetch
  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + 100_000,
      }),
    { models: {} },
  )
  await expect(
    result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    }),
  ).rejects.toThrow(/API key/i)
  expect(modelRequests).toEqual([])
  expect(await readFeedEntries()).toEqual([])
  const runtime = createNativeAccountRuntime({
    paths: migratedPool!.paths,
    host: 'opencode',
  })
  try {
    expect(await runtime.authorizeLocal('main')).toEqual({
      status: 'refused',
      reason: 'unsupported-access',
      persisted: false,
    })
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  } finally {
    runtime.close()
  }
}

/**
 * Fail if `value` (stored account metadata, a recorded error) carries any
 * part of an OAuth token or API key this test's pool knows: an access or
 * refresh token of a migrated login or of a later login of its accounts, or
 * any `sk-ant-` token prefix.
 */
function expectNoCredentialFragment(value: unknown) {
  const text = JSON.stringify(value ?? null)
  expect(text).not.toContain('sk-ant-')
  for (const login of poolLogins) {
    expect(text).not.toContain(login.access)
    expect(text).not.toContain(login.refresh)
  }
  for (const access of successorAccess.keys())
    expect(text).not.toContain(access)
}

/** Settings as the native runtime reads them back from the migrated pool. */
async function readNativeSettings(): Promise<Record<string, unknown>> {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    return (await runtime.read()).settings
  } finally {
    runtime.close()
  }
}

/** Publish a poll through the current native credential's guarded writer. */
async function publishNativeMainQuota(quota: OAuthQuotaSnapshot) {
  if (!migratedPool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: migratedPool.paths,
    host: 'opencode',
  })
  try {
    const authorization = await runtime.authorizeLocal('main')
    if (authorization.status !== 'usable')
      throw new Error(
        `Main quota publication cannot authorize: ${authorization.status}`,
      )
    if (!authorization.binding.identity)
      throw new Error('Main quota publication requires an account UUID')
    if (
      !(await runtime.publishLocal(authorization.subject, {
        quota: { ...quota, accountIdentity: authorization.binding.identity },
      }))
    )
      throw new Error('Main quota publication refused the current credential')
    return authorization.subject
  } finally {
    runtime.close()
  }
}

/**
 * Per-account runtime state as the native pool records it, in the shape of
 * the retired legacy state file: `main` and `accounts[routeId]`, each with
 * its account identity, quota, profile, prime counters and recorded errors. The main
 * account's quota error keeps its legacy name, `lastQuotaApiError`. Native
 * reads carry no credential material.
 */
async function readNativeRuntimeState() {
  const pool = migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const snapshot = await runtime.read()
    const project = (account: (typeof snapshot.accounts)[number]) => ({
      accountIdentity: account.accountIdentity,
      quota: account.quota,
      profile: account.profile,
      prime: account.prime,
      lastRefreshError: account.lastRefreshError,
      lastQuotaRefreshError: account.lastQuotaRefreshError,
    })
    const main = snapshot.accounts.find((account) => account.id === 'main')
    return {
      main: main && {
        ...project(main),
        lastQuotaApiError: main.lastQuotaRefreshError,
      },
      accounts: Object.fromEntries(
        snapshot.accounts
          .filter((account) => account.id !== 'main')
          .map((account) => [account.id, project(account)]),
      ),
    }
  } finally {
    runtime.close()
  }
}

/** The latest ignored reply text sent to a session without a connected TUI. */
function latestIgnoredReply(client: ReturnType<typeof createMockClient>) {
  const calls = (
    client.session.promptAsync as unknown as {
      mock: {
        calls: Array<
          [{ body: { parts: Array<{ text: string; ignored?: boolean }> } }]
        >
      }
    }
  ).mock.calls
  const part = calls.at(-1)?.[0]?.body.parts[0]
  expect(part?.ignored).toBe(true)
  return part?.text ?? ''
}

/** Open /claude for a TUI-connected session and return the menu payload. */
async function openClaudeMenu(plugin: any, sessionId: string) {
  // The TUI polls its session's notifications; the plugin treats a recent
  // poll as a connected TUI, so draining here makes the session interactive.
  drainNotifications(0, sessionId)
  await expectHandledCommandResponse(
    plugin['command.execute.before']({
      command: 'claude',
      arguments: '',
      sessionID: sessionId,
    }),
  )
  const notice = drainNotifications(0, sessionId).at(-1)
  if (notice?.type !== 'open-menu')
    throw new Error('Expected the /claude menu notification')
  drainNotifications(notice.id, sessionId)
  return notice.payload
}

/**
 * Open /claude, then submit one menu action through the plugin's RPC server
 * the way the TUI renderer does. The plugin starts that server only when it
 * is given a project directory, so create it with the migrated root.
 */
async function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  await openClaudeMenu(plugin, sessionId)
  const rpcDir = process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR
  if (!rpcDir) throw new Error('Missing isolated RPC directory')
  // Provider mocks reject loopback URLs; only the RPC request goes to the
  // preload's loopback-only fetch.
  const providerFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new URL(input instanceof Request ? input.url : String(input)).hostname ===
      '127.0.0.1'
        ? loopbackFetch(input, init)
        : providerFetch(input, init),
    { preconnect: providerFetch.preconnect },
  ) as typeof fetch
  try {
    return await createRpcClient(rpcDir, process.pid).applyMenu({
      command: 'claude',
      sessionId,
      ...request,
    })
  } finally {
    globalThis.fetch = providerFetch
  }
}

function restoreProcessTestFiles() {
  const testDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  if (!testDir) return
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    testDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    testDir,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    testDir,
    'opencode-enrollment.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    testDir,
    'cachekeep-registry',
  )
}

async function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await getSidebarState()
    if (predicate(state)) return state
    await Bun.sleep(10)
  }
  const state = await getSidebarState()
  throw new Error(`Sidebar state did not match: ${JSON.stringify(state)}`)
}

/**
 * The account storage a plugin process sees. For a migrated pool this is the
 * native runtime's AccountStorage-shaped projection (settings, account
 * metadata and quota, never credential material), the same view the plugin
 * reads; migration retires the legacy files. Without a migrated pool it is
 * the unmigrated legacy store.
 */
async function readAccountStorage(): Promise<AccountStorage | null> {
  const pool = migratedPool
  if (!pool) return loadAccounts()
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    return (await runtime.read()).policyStorage
  } finally {
    runtime.close()
  }
}

async function waitForAccountStorage(
  predicate: (storage: Awaited<ReturnType<typeof loadAccounts>>) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const storage = await readAccountStorage()
    if (predicate(storage)) return storage
    await Bun.sleep(10)
  }
  const storage = await readAccountStorage()
  throw new Error(`Account storage did not match: ${JSON.stringify(storage)}`)
}

async function seedSidebarRouting(
  activeId: string,
  route: string,
  lastUpdated: number,
) {
  await setSidebarState({
    ...(await getSidebarState()),
    activeId,
    route,
    lastUpdated,
  })
}

async function waitForMockCall(fn: { mock?: { calls: unknown[] } }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((fn.mock?.calls.length ?? 0) > 0) return
    await Bun.sleep(10)
  }
}

/**
 * Set up the common test scaffolding for concurrent refresh tests:
 * mocks setTimeout to be synchronous and creates a plugin loader
 * whose migrated main login has an already-expired access token.
 * The tokens the test's token endpoint issues are later tokens of that
 * same account. Quota routing is off, so every request is actually sent
 * with the refreshed token rather than answered locally for unknown quota.
 */
async function setupExpiredTokenLoader(...issuedAccess: string[]) {
  const expiredLogin = {
    access: 'sk-ant-oat01-expired-token',
    refresh: 'old-refresh',
    expires: Date.now() - 1000,
  }
  await useTempAccountFile(
    createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    expiredLogin,
  )
  mainAccountIssues(...issuedAccess)
  const setTimeoutMock = mock((handler: () => unknown) => {
    handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  const mockClient = createMockClient()
  const plugin = await getPlugin(mockClient, undefined, {
    setTimeout: setTimeoutMock,
  })
  const result = await plugin.auth.loader(
    () => Promise.resolve({ type: 'oauth', ...expiredLogin }),
    { models: {} },
  )

  return { mockClient, result }
}

/** Fire 5 concurrent fetch requests against /v1/messages. */
function fireConcurrentFetches(result: { fetch: typeof fetch }) {
  return Promise.all(
    Array.from({ length: 5 }, () => result.fetch(MESSAGES_URL, EMPTY_POST)),
  )
}

type PluginRuntimeOverrides = Partial<{
  authorize: typeof import('@cortexkit/anthropic-auth-core').authorize
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  scopedRosterPollIntervalMs: number
  claustrumScopedConnect: () => Promise<NativeCustodyClient>
  cacheKeepAggregateRefreshIntervalMs: number
}>

function disabledPluginRuntimeOverrides(): PluginRuntimeOverrides {
  return {
    // Background intervals must not outlive the test-scoped fetch mock they captured.
    setInterval: mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval,
    clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    scopedRosterPollIntervalMs: 0,
    cacheKeepAggregateRefreshIntervalMs: 0,
  }
}

let pluginRuntimeOverrides: PluginRuntimeOverrides = {}

beforeEach(() => {
  resetClaudeCodeIdentityCachesForTest()
})

async function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
) {
  const defaultTimerOverrides = disabledPluginRuntimeOverrides()
  const creation = (
    AnthropicAuthPlugin as unknown as (
      ctx: Parameters<typeof AnthropicAuthPlugin>[0],
      runtimeOverrides?: PluginRuntimeOverrides,
    ) => ReturnType<typeof AnthropicAuthPlugin>
  )(
    {
      // @ts-expect-error: minimal mock for testing
      client: client ?? createMockClient(),
      ...(directory && { directory }),
    },
    {
      ...defaultTimerOverrides,
      ...pluginRuntimeOverrides,
      ...runtimeOverrides,
    },
  )
  testLifetime?.trackDetached(creation)
  const plugin = (await creation) as any
  livePlugins.add(plugin)
  if (plugin.__fallbackRefreshReady) {
    fallbackRefreshes.add(plugin.__fallbackRefreshReady)
  }
  const pool = migratedPool
  const loader = plugin.auth?.loader
  if (pool && loader) {
    // After migration, OpenCode's auth store answers with the inert
    // activation, not the test's literal OAuth tokens.
    plugin.auth.loader = (
      hostGetAuth: () => Promise<Record<string, unknown>>,
      provider: unknown,
    ) => loader(() => migratedHostAuth(pool, hostGetAuth), provider)
  }
  return plugin
}

describe('scoped enrollment is explicit', () => {
  test('account dialog reports approved enrollment without false setup guidance for a vault-served main', async () => {
    const vault = mainOnlyVault()
    const fixture = await useVaultAccountFile(
      createFallbackStorage({
        accounts: [],
        mainAccountId: 'primary-route',
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: 'oauth:anthropic',
            accountId: syntheticMainIdentity as ProviderAccountUuid,
            state: 'active',
          },
        },
      }),
      vault,
    )
    const sessionId = `ses_approved_vault_account_dialog_${randomUUID()}`
    const plugin = await getPlugin(undefined, fixture.root, {
      claustrumScopedConnect: async () => vault,
    })
    const menu = await openClaudeMenu(plugin, sessionId)
    const status = (
      menu.menu.sections.find((section) => section.id === 'Accounts')?.lines ??
      []
    ).join('\n')
    // The main account's status line names the vault as its source.
    expect(status).toContain('[main] enabled — vault')
    expect(status).toContain('approved as enrolled:anthropic-auth-opencode')
    expect(status).not.toContain('scoped serving not active yet')
    expect(status).not.toContain('Quit the host and run')
  })

  test('boot and account status are read-only for an unscoped Claustrum configuration', async () => {
    // A Claustrum configuration without a scoped account roster cannot migrate.
    // Startup and status reads must not propose or persist enrollment state.
    await useUnmigratedAccountFile(
      createFallbackStorage({ accounts: [], claustrum: { mode: 'claustrum' } }),
    )
    const enrollmentFile =
      process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
    if (!enrollmentFile) throw new Error('Missing isolated enrollment path')
    const stateFile = enrollmentFile.replace(/\.json$/, '-state.json')
    const plugin = await getPlugin(createMockClient())
    await openClaudeMenu(plugin, 'ses_read_only')
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // Also reject the enrollment-starting call in source: detached enrollment
    // work could begin after the file-absence assertion has already passed.
    const pluginSource = await readFile(
      join(import.meta.dir, '..', 'index.ts'),
      'utf8',
    )
    expect(pluginSource.includes('adoptClaustrumEnrollment')).toBe(false)
  })

  test('enrollment-reset only clears terminal state; setup owns the next proposal', async () => {
    const vault = mainOnlyVault()
    const fixture = await useVaultAccountFile(
      createFallbackStorage({
        accounts: [],
        mainAccountId: 'primary-route',
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: 'oauth:anthropic',
            accountId: syntheticMainIdentity as ProviderAccountUuid,
            state: 'active',
          },
        },
      }),
      vault,
    )
    // Represent lost host enrollment by removing its consumer token. Keep a
    // terminal refusal record so reset clears that record without proposing.
    await rm(fixture.enrollmentPath)
    const stateFile = fixture.enrollmentPath.replace(/\.json$/, '-state.json')
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        phase: 'blocked',
        proposedName: 'anthropic-auth-opencode',
        errorCode: 'superseded',
        updatedAt: Date.now(),
      }),
      { mode: 0o600 },
    )
    const plugin = await getPlugin(createMockClient(), fixture.root, {
      claustrumScopedConnect: async () => vault,
    })
    const result = await applyMenuAction(plugin, 'ses_reset_only', {
      sectionId: 'Accounts',
      actionId: 'enrollment-reset',
      confirmed: true,
    })
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(result.text).toContain('setup')
  })
})
describe('desktop notice identity (#230)', () => {
  test('orders repeated notices before the same assistant with bounded IDs', async () => {
    const plugin = await getPlugin()
    const mint = plugin.__notificationMessageIdBeforeAssistantForTest
    const assistant = 'msg_0000000f0000BBBBBBBBBBBBBB'
    let previous = 'msg_0000000efffeAAAAAAAAAAAAAA'
    for (let index = 0; index < 20; index++) {
      const next = mint(assistant, previous)
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
    const plugin = await getPlugin()
    const track = plugin.__trackDesktopNoticeMessageIdForTest
    const has = plugin.__isDesktopNoticeMessageForTest
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

describe('fallback quota persistence ordering', () => {
  test('does not restore a late quota error older than the persisted success', async () => {
    const successAt = Date.now()
    await useTempAccountFile(
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
    )

    const plugin = await getPlugin()
    await plugin.__persistFallbackQuotaErrorForTest('fallback-late-error', {
      message: 'older quota failure',
      checkedAt: successAt - 1,
      nextRetryAt: successAt + 60_000,
      retryCount: 1,
      accountIdentity: 'fallback-late-error',
    })
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

async function readFeedEntries() {
  const directory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
  try {
    // The producer writes a complete .tmp before renaming it into a committed
    // .json lease. Match the real consumer: transient files are not published.
    const files = (await readdir(directory)).filter((name) =>
      name.endsWith('.json'),
    )
    const records = await Promise.all(
      files.map(async (file) =>
        JSON.parse(await readFile(join(directory, file), 'utf8')),
      ),
    )
    return records.flatMap((record) => Object.values(record.entries ?? {}))
  } catch {
    return []
  }
}

async function waitForFeedEntries(
  predicate: (entries: Awaited<ReturnType<typeof readFeedEntries>>) => boolean,
  description: string,
) {
  const deadline = performance.now() + 2_500
  let entries = await readFeedEntries()
  while (!predicate(entries) && performance.now() < deadline) {
    await Bun.sleep(10)
    entries = await readFeedEntries()
  }
  if (!predicate(entries)) {
    throw new Error(
      `Quota header feed did not match ${description}: ${JSON.stringify(entries)}`,
    )
  }
  return entries
}

async function waitForLogRecord(
  records: LogTestRecord[],
  predicate: (record: LogTestRecord) => boolean,
  description: string,
) {
  const deadline = performance.now() + 2_500
  while (!records.some(predicate) && performance.now() < deadline) {
    await Bun.sleep(10)
  }
  if (!records.some(predicate)) {
    throw new Error(
      `Expected log record ${description}: ${JSON.stringify(records)}`,
    )
  }
}

async function loadMainAndFetch(
  storage: AccountStorage,
  response: Response | (() => Response),
  requestHeaders?: Record<string, string>,
) {
  await useTempAccountFile(storage)
  globalThis.fetch = mock(
    withNativeAdmission(() =>
      Promise.resolve(
        typeof response === 'function' ? response() : response.clone(),
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
  const fetched = await result.fetch(MESSAGES_URL, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
  })
  return { plugin, response: fetched }
}

describe('quota header feed integration', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

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
        paths: migratedPool!.paths,
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
      if (!migratedPool) throw new Error('Missing migrated fixture')
      const entered = bodyLifetime().gate()
      const release = bodyLifetime().gate()
      // Pause a real pool quota write after credential admission. The header
      // harvest must reconcile the poll's fields when that write completes.
      const writer = createNativeAccountRuntime({
        paths: migratedPool.paths,
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
        await Promise.race([
          entered.wait,
          pollWriter.then(() => {
            throw new Error('Poll writer did not reach its pause')
          }),
        ])
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
        // Response completion also records account use under the pool locks.
        // Release the poll after header arrival, not after that write.
        firstRequest = Promise.resolve(result.fetch(MESSAGES_URL, EMPTY_POST))
        bodyLifetime().trackDetached(firstRequest)
        await entered.wait
        const cache = (
          plugin as unknown as {
            __quotaManager: {
              getMain(identity: string): { quota: OAuthQuotaSnapshot } | null
            }
          }
        ).__quotaManager
        await waitForLogRecord(
          records,
          (record) =>
            record.channel === 'quota' &&
            record.message === 'response quota awaiting publication' &&
            record.payload?.account === 'main',
          'header observation awaiting the held poll write',
        )
        expect(cache.getMain(mainAccountId)?.quota.checkedAt).toBe(
          pollCheckedAt,
        )
        release.open()
        if (!pollWriter)
          throw new Error(
            'First model request did not start the native poll writer',
          )
        expect(await pollWriter).toBe(true)
        expect((await readAccountStorage())?.quota?.mainQuota?.scoped).toEqual(
          scoped,
        )
        const firstResponse = await firstRequest
        expect(firstResponse.status).toBe(200)
        await firstResponse.text()
        await waitForAccountStorage(
          (loaded) => loaded?.quota?.mainQuota?.checkedAt === clock,
        )
        expect((await readAccountStorage())?.quota?.mainQuota?.scoped).toEqual(
          scoped,
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
        writer.close()
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
        (candidate) => candidate?.quota?.mainQuota?.checkedAt === clock,
      )
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
      const quotaManager = plugin.__quotaManager
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

      if (!migratedPool) throw new Error('Missing migrated pool')
      const replacementRuntime = createNativeAccountRuntime({
        paths: migratedPool.paths,
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
        replacementRuntime.close()
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
      const quotaManager = plugin.__quotaManager
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
      if (!migratedPool) throw new Error('Missing migrated pool')
      const replacementRuntime = createNativeAccountRuntime({
        paths: migratedPool.paths,
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

  test('main account replacement fences quota, backoff, and feed identity', async () => {
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
          quotaHeaderFeed: { enabled: true },
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
    const quotaManager = plugin.__quotaManager
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
      const entries = await waitForFeedEntries(
        (entries) =>
          entries.some(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              'anthropic_account_uuid' in entry &&
              entry.anthropic_account_uuid === uuidB,
          ),
        'replacement account quota feed',
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
      expect(entries).toContainEqual(
        expect.objectContaining({
          identity_source: 'account_ref',
          anthropic_account_uuid: uuidB,
        }),
      )
      expect(await readFeedEntries()).not.toContainEqual(
        expect.objectContaining({ anthropic_account_uuid: uuidA }),
      )
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
    expect(plugin.__quotaManager.isBackedOff()).toBe(true)
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
    if (!migratedPool) throw new Error('This test has no migrated pool')
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
      paths: migratedPool.paths,
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
    ).rejects.toThrow('Native OAuth authorization refused: refused')
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
    expect(plugin.__quotaManager.isBackedOff()).toBe(false)
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
    expect(plugin.__quotaManager.isBackedOff()).toBe(true)
    if (!migratedPool) throw new Error('This test has no migrated pool')
    const runtime = createNativeAccountRuntime({
      paths: migratedPool.paths,
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
      expect(plugin.__quotaManager.isBackedOff()).toBe(false)
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
          quotaHeaderFeed: { enabled: true },
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
      await waitForFeedEntries(
        (entries) =>
          entries.some(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              'anthropic_account_uuid' in entry &&
              entry.anthropic_account_uuid === uuidB,
          ),
        'new account observation before old response release',
      )
      expect(
        plugin.__quotaManager.getMain(uuidB)?.quota.five_hour?.usedPercent,
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
      expect(await readFeedEntries()).not.toContainEqual(
        expect.objectContaining({ anthropic_account_uuid: uuidA }),
      )
      expect(plugin.__quotaManager.getMain(uuidA)).toBeNull()
      expect(
        plugin.__quotaManager.getMain(uuidB)?.quota.five_hour?.usedPercent,
      ).toBe(60)
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

  test('mints before background refresh can observe storage and survives token rotation', async () => {
    await useTempAccountFile(
      createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const observedIds: (string | undefined)[] = []
    const timerObservedIds: (string | undefined)[] = []
    let authCalls = 0
    const auth = () => {
      authCalls += 1
      if (authCalls > 1) {
        void readAccountStorage().then((storage) =>
          observedIds.push(storage?.mainAccountId),
        )
      }
      return Promise.resolve({
        type: 'oauth' as const,
        access: `access-${authCalls}`,
        refresh: `refresh-${authCalls}`,
        expires: Date.now() + 100_000,
      })
    }
    const plugin = await getPlugin(undefined, undefined, {
      setInterval: ((callback: () => void) => {
        const config = JSON.parse(
          readFileSync(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
        ) as { mainAccountId?: unknown }
        timerObservedIds.push(
          typeof config.mainAccountId === 'string'
            ? config.mainAccountId
            : undefined,
        )
        callback()
        return { unref() {} } as unknown as ReturnType<typeof setInterval>
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    })
    timerObservedIds.length = 0

    await plugin.auth.loader(auth, { models: {} })
    await Bun.sleep(25)
    const first = (await readAccountStorage())?.mainAccountId
    await plugin.auth.loader(auth, { models: {} })
    const second = (await readAccountStorage())?.mainAccountId

    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(second).toBe(first)
    expect(timerObservedIds).toEqual([first, first])
    expect(observedIds).toContain(first)
  })
})

describe('package metadata', () => {
  test('exports a runtime-loadable TUI entrypoint', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      exports?: Record<string, { import?: string; types?: string }>
      files?: string[]
      'oc-plugin'?: string[]
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
    }

    expect(packageJson.exports?.['./tui']).toEqual({
      types: './dist/tui.d.ts',
      import: './src/tui/entry.mjs',
    })
    expect(packageJson.files).toContain('src/tui.tsx')
    expect(packageJson.files).toContain('src/tui')
    expect(packageJson.files).toContain('src/tui-compiled')
    expect(packageJson.files).toContain('src/sidebar-state.ts')
    expect(packageJson['oc-plugin']).toEqual(['server', 'tui'])
    expect(packageJson.scripts?.build).toContain('bun run build:tui')
    for (const dependency of ['@opentui/core', '@opentui/solid', 'solid-js']) {
      expect(packageJson.dependencies?.[dependency]).toMatch(/^\d/)
    }
  })

  test('raw TUI fallback is loadable for development hosts', async () => {
    const mod = await import('../tui.tsx')
    expect(mod.default?.id).toBe('cortexkit.anthropic-auth')
    expect(mod.default?.tui).toBeFunction()
  })
})

describe('AnthropicAuthPlugin', () => {
  test('fixed auth content refuses before creating the main OAuth URL', async () => {
    await useTempAccountFile({ version: 1, accounts: [] })
    const previous = process.env.OPENCODE_AUTH_CONTENT
    process.env.OPENCODE_AUTH_CONTENT = '{}'
    try {
      const authorize = mock(() =>
        Promise.resolve({
          url: 'https://example.test/oauth',
          redirectUri: 'https://example.test/callback',
          state: 'state',
          verifier: 'verifier',
        }),
      )
      const plugin = await getPlugin(undefined, undefined, { authorize })
      await expect(plugin.auth.methods[0].authorize()).rejects.toThrow(
        'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
      )
      expect(authorize).not.toHaveBeenCalled()
      // The refused login added no account to the native pool.
      const state = await readNativeRuntimeState()
      expect(state.accounts).toEqual({})
      await plugin.dispose?.()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
      else process.env.OPENCODE_AUTH_CONTENT = previous
    }
  })

  test('returns an object with auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
    expect(plugin.provider?.id).toBe('anthropic')
    expect(plugin.provider?.models).toBeFunction()
  })

  test('refresh error merge prefers the newer observation by checkedAt', async () => {
    const accountId = 'fallback-fence-recency'
    const now = Date.now()
    const errorAt = (checkedAt: number, message: string) =>
      buildRefreshOperationError({
        error: new ClaudeOAuthRefreshError(
          400,
          `{"error":"invalid_grant","m":"${message}"}`,
        ),
        now: checkedAt,
        accountIdentity: accountId,
      })
    await useTempAccountFile(
      createFallbackStorage({
        quota: { enabled: false },
        accounts: [
          {
            id: accountId,
            type: 'oauth',
            access: 'sk-ant-oat01-dead',
            refresh: 'dead-refresh',
            expires: now + 3 * 60 * 60_000,
            lastRefreshedAt: now - 60_000,
            lastRefreshError: errorAt(now - 200_000, 'older-latch'),
          },
        ],
        claustrum: { mode: 'local' },
      }),
    )
    const newerSnapshot = await readAccountStorage()
    if (!newerSnapshot) throw new Error('missing test storage')
    const newerAccount = newerSnapshot.accounts.find(
      (account): account is OAuthAccount =>
        account.id === accountId && isOAuthAccount(account),
    )
    if (!newerAccount) throw new Error('missing account')
    newerAccount.lastRefreshError = errorAt(now, 'newer-incoming')
    await saveAccounts(newerSnapshot)
    const afterNewer = (await readAccountStorage())?.accounts.find(
      (account): account is OAuthAccount =>
        account.id === accountId && isOAuthAccount(account),
    )
    expect(afterNewer?.lastRefreshError?.message).toContain('newer-incoming')

    const olderSnapshot = await readAccountStorage()
    if (!olderSnapshot) throw new Error('missing test storage')
    const olderAccount = olderSnapshot.accounts.find(
      (account): account is OAuthAccount =>
        account.id === accountId && isOAuthAccount(account),
    )
    if (!olderAccount) throw new Error('missing account')
    olderAccount.lastRefreshError = errorAt(now - 300_000, 'older-incoming')
    await saveAccounts(olderSnapshot)
    const afterOlder = (await readAccountStorage())?.accounts.find(
      (account): account is OAuthAccount =>
        account.id === accountId && isOAuthAccount(account),
    )
    expect(afterOlder?.lastRefreshError?.message).toContain('newer-incoming')
  })
})

describe('experimental.chat.system.transform', () => {
  test('injects parallel tool-call prompt only for Anthropic chat sessions', async () => {
    const plugin = await getPlugin()
    const system = ['base system']

    await plugin['experimental.chat.system.transform'](
      {
        sessionID: 'ses_test',
        model: { providerID: 'anthropic', id: 'claude-opus-4-8' },
      },
      { system },
    )

    expect(system).toEqual(['base system', PARALLEL_TOOL_CALLS_SYSTEM_PROMPT])
  })

  test('does not inject parallel tool-call prompt for non-Anthropic models', async () => {
    const plugin = await getPlugin()
    const system = ['base system']

    await plugin['experimental.chat.system.transform'](
      {
        sessionID: 'ses_test',
        model: { providerID: 'openai', id: 'gpt-5.5-fast' },
      },
      { system },
    )

    expect(system).toEqual(['base system'])
  })

  test('does not inject parallel tool-call prompt outside chat sessions', async () => {
    const plugin = await getPlugin()
    const system = ['base system']

    await plugin['experimental.chat.system.transform'](
      {
        model: { providerID: 'anthropic', id: 'claude-opus-4-8' },
      },
      { system },
    )

    expect(system).toEqual(['base system'])
  })

  test('does not duplicate an existing parallel tool-call prompt', async () => {
    const plugin = await getPlugin()
    const system = ['base system', PARALLEL_TOOL_CALLS_SYSTEM_PROMPT]

    await plugin['experimental.chat.system.transform'](
      {
        sessionID: 'ses_test',
        model: { providerID: 'anthropic', id: 'claude-opus-4-8' },
      },
      { system },
    )

    expect(system).toEqual(['base system', PARALLEL_TOOL_CALLS_SYSTEM_PROMPT])
  })

  test('parallel tool-call prompt forbids parallelizing dependent calls', () => {
    expect(PARALLEL_TOOL_CALLS_SYSTEM_PROMPT).toContain(
      'Do not parallelize tool calls when one call depends on the output of another call.',
    )
    expect(PARALLEL_TOOL_CALLS_SYSTEM_PROMPT).toContain(
      'Never invent placeholder IDs, guessed task IDs, or other guessed values',
    )
  })
})

describe('quota header feed extended integration', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

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

  test('sidebar quota refresh uses the rotated main host token', async () => {
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
    globalThis.fetch = mock(
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
    ) as unknown as typeof fetch
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

    const resolved = await (
      plugin as {
        __resolveSidebarQuotaAccessForTest: () => Promise<{
          access: string | undefined
        }>
      }
    ).__resolveSidebarQuotaAccessForTest()
    expect(resolved.access).toBe('sk-ant-oat01-main-access-after-rotation')
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
        expect(messageAuthorizations).toContain(
          'Bearer sk-ant-oat01-refreshed-fallback-access',
        )
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
    await saveAccountState(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE, {
      mainQuota: true,
    })
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

describe('auth.methods', () => {
  test('has three auth methods', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth.methods).toHaveLength(3)
  })

  test('first method is Claude Pro/Max OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[0]
    expect(method.label).toBe('Claude Pro/Max')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('second method is Create an API Key OAuth with code flow', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[1]
    expect(method.label).toBe('Create an API Key')
    expect(method.type).toBe('oauth')
    expect(method.authorize).toBeFunction()
  })

  test('third method is manual API key', async () => {
    const plugin = await getPlugin()
    const method = plugin.auth.methods[2]
    expect(method.label).toBe('Manually enter API Key')
    expect(method.type).toBe('api')
    expect(method.provider).toBe('anthropic')
  })
})

test('test setup keeps sidebar state off the production default path', () => {
  const testDir = process.env.OPENCODE_ANTHROPIC_AUTH_TEST_DIR
  expect(typeof testDir).toBe('string')
  if (!testDir) throw new Error('missing test directory')
  restoreProcessTestFiles()
  expect(getSidebarStateFile().startsWith(`${testDir}/`)).toBe(true)
  expect(
    process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR?.startsWith(
      `${testDir}/`,
    ),
  ).toBe(true)
})

describe('OAuth billing lineage', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('advances cc_prev_req from genuine HTTP relay response headers', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: false,
          transport: 'http',
        },
      }),
    )
    const sentBillingHeaders: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(
              Response.json({
                oauth_account: { account_uuid: 'billing-relay-account' },
              }),
            )
          }
          if (url.startsWith('https://relay.example.test')) {
            const payload = JSON.parse(String(init?.body)) as { body?: string }
            const body = JSON.parse(String(payload.body)) as {
              system?: Array<{ text?: string }>
            }
            sentBillingHeaders.push(String(body.system?.[0]?.text ?? ''))
            return Promise.resolve(
              new Response('{}', {
                status: 200,
                headers: {
                  'request-id':
                    sentBillingHeaders.length === 1
                      ? 'req_011111111111111111111111'
                      : 'req_022222222222222222222222',
                },
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const messages = [
      {
        info: {
          id: 'msg_billing_relay',
          role: 'user',
          sessionID: 'ses_billing_relay',
        },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]
    await plugin['experimental.chat.messages.transform']({}, { messages })
    const auth = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const send = async (affinity: string) => {
      const output = { headers: {} as Record<string, string> }
      await plugin['chat.headers'](
        {
          sessionID: 'ses_billing_relay',
          message: { id: 'msg_billing_relay' },
        },
        output,
      )
      return auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          ...output.headers,
          'x-session-affinity': affinity,
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    }

    expect((await send('billing-relay-first')).status).toBe(200)
    expect((await send('billing-relay-second')).status).toBe(200)
    const firstPromptId = sentBillingHeaders[0]?.match(
      /cc_prompt_id=([^;]+);/,
    )?.[1]
    expect(firstPromptId).toBeTruthy()
    expect(sentBillingHeaders[0]).not.toContain('cc_prev_req=')
    expect(sentBillingHeaders[1]).toContain(`cc_prompt_id=${firstPromptId};`)
    expect(sentBillingHeaders[1]).toContain(
      'cc_prev_req=req_011111111111111111111111;',
    )
  })
})

describe('Fable 5.1 request-scoped effort history', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    __setLogTestSink(null)
  })

  test('preserves effort boundaries when OpenCode lowers multiple assistant records into one message', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
        thinkingBinding: { prefixMismatchBehavior: 'error' },
      }),
    )
    let sentBody: Record<string, any> | undefined
    let sentHeaders: Headers | undefined
    const sentBillingHeaders: string[] = []
    const upstreamRequestIds = [
      'req_011111111111111111111111',
      'req_022222222222222222222222',
      'req_033333333333333333333333',
    ]
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(
              Response.json({
                oauth_account: { account_uuid: 'effort-account' },
              }),
            )
          }
          if (url.includes('/v1/messages')) {
            sentBody = JSON.parse(String(init?.body))
            sentHeaders = new Headers(init?.headers)
            sentBillingHeaders.push(String(sentBody?.system?.[0]?.text ?? ''))
            return Promise.resolve(
              new Response('{}', {
                status: 200,
                headers: {
                  'request-id':
                    upstreamRequestIds[sentBillingHeaders.length - 1] ??
                    'req_099999999999999999999999',
                },
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const messages = [
      {
        info: {
          id: 'msg_effort_low',
          role: 'user',
          sessionID: 'ses_effort',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'low',
          },
        },
        parts: [{ type: 'text', text: 'first' }],
      },
      {
        info: {
          id: 'msg_effort_step_1',
          role: 'assistant',
          sessionID: 'ses_effort',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_effort_step_2',
          role: 'assistant',
          sessionID: 'ses_effort',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_effort_high',
          role: 'user',
          sessionID: 'ses_effort',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'high',
          },
        },
        parts: [{ type: 'text', text: 'second' }],
      },
      {
        info: {
          id: 'msg_effort_current',
          role: 'user',
          sessionID: 'ses_effort',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'high',
          },
        },
        parts: [{ type: 'text', text: 'current' }],
      },
    ]
    await plugin['experimental.chat.messages.transform']({}, { messages })
    const loweredUserContent = (index: number) =>
      messages[index]?.parts
        .filter((part) => part.type === 'text')
        .map((part) => ({ type: 'text', text: part.text }))
    const output = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      { sessionID: 'ses_effort', message: { id: 'msg_effort_current' } },
      output,
    )

    const auth = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const loweredRequestBody = JSON.stringify({
      model: 'claude-fable-5-1',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'trace', signature: 'sig' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'user', content: loweredUserContent(3) },
        { role: 'user', content: loweredUserContent(4) },
      ],
    })
    const send = (headers: Record<string, string>) =>
      auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          ...headers,
          'x-session-affinity': 'ses_effort',
        },
        body: loweredRequestBody,
      })
    expect((await send(output.headers)).status).toBe(200)
    const firstPromptId = sentBillingHeaders[0]?.match(
      /cc_prompt_id=([^;]+);/,
    )?.[1]
    expect(firstPromptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(sentBillingHeaders[0]).not.toContain('cc_prev_req=')

    const retryOutput = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      { sessionID: 'ses_effort', message: { id: 'msg_effort_current' } },
      retryOutput,
    )
    expect(retryOutput.headers['x-cortexkit-effort-plan']).toBe(
      output.headers['x-cortexkit-effort-plan'],
    )
    expect((await send(retryOutput.headers)).status).toBe(200)
    expect(sentBillingHeaders[1]).toContain(`cc_prompt_id=${firstPromptId};`)
    expect(sentBillingHeaders[1]).toContain(
      'cc_prev_req=req_011111111111111111111111;',
    )

    expect(sentBody?.output_config).toEqual({ effort: 'low' })
    expect(sentBody?.messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'trace', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'current' }],
      },
    ])
    expect(sentBody?.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    })
    expect(sentHeaders?.get('anthropic-beta')).toContain(
      'mid-conversation-output-config-2026-07-01',
    )
    expect(sentHeaders?.get('anthropic-beta')).toContain(
      'thinking-binding-controls-2026-08-01',
    )
    expect(
      [...(sentHeaders?.keys() ?? [])].some((header) =>
        header.startsWith('x-cortexkit-effort'),
      ),
    ).toBe(false)
    expect(sentHeaders?.has('x-cortexkit-billing-lineage')).toBe(false)

    const prefixTrimmedResponse = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        ...retryOutput.headers,
        'x-session-affinity': 'ses_effort',
      },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: loweredUserContent(4) }],
      }),
    })
    expect(prefixTrimmedResponse.status).toBe(200)
    expect(sentBody?.output_config).toEqual({ effort: 'high' })
    expect(sentBody?.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'current' }],
      },
    ])
  })

  test('fails locally when request-correlated effort markers cannot be validated', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
      }),
    )
    let messagesCalled = false
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: 'effort-account' },
            }),
          )
        }
        if (url.includes('/v1/messages')) messagesCalled = true
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const markedMessages = [
      {
        info: {
          id: 'msg_marked_low',
          role: 'user',
          sessionID: 'ses_effort_invalid',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'low',
          },
        },
        parts: [{ type: 'text', text: 'low effort' }],
      },
      {
        info: {
          id: 'msg_marked_assistant',
          role: 'assistant',
          sessionID: 'ses_effort_invalid',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_marked_high',
          role: 'user',
          sessionID: 'ses_effort_invalid',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'high',
          },
        },
        parts: [{ type: 'text', text: 'high effort' }],
      },
    ]
    await plugin['experimental.chat.messages.transform'](
      {},
      { messages: markedMessages },
    )
    const internalTexts = markedMessages[2]?.parts.flatMap((part) =>
      typeof part.text === 'string' ? [part.text] : [],
    )
    const transitionMarker = internalTexts?.find((text) =>
      text.startsWith(EFFORT_MARKER_PREFIX),
    )
    const anchorMarker = internalTexts?.find((text) =>
      text.includes('cortexkit-internal-effort-anchor'),
    )
    expect(transitionMarker).toBeString()
    expect(anchorMarker).toBeString()
    const correlatedHeaders = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      {
        sessionID: 'ses_effort_invalid',
        message: { id: 'msg_marked_high' },
      },
      correlatedHeaders,
    )
    const effortPlanHeader =
      correlatedHeaders.headers['x-cortexkit-effort-plan']
    expect(effortPlanHeader).toBeString()

    const auth = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const send = (
      sessionId: string,
      internal: Array<string | undefined>,
      includeEffortPlan = true,
    ) =>
      auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-session-affinity': sessionId,
          ...(includeEffortPlan && effortPlanHeader
            ? { 'x-cortexkit-effort-plan': effortPlanHeader }
            : {}),
        },
        body: JSON.stringify({
          model: 'claude-fable-5-1',
          output_config: { effort: 'high' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'correlation failure' },
                ...internal.map((text) => ({ type: 'text', text })),
              ],
            },
          ],
        }),
      })

    const missingRequestPlan = await send(
      'ses_effort_missing_request_plan',
      [transitionMarker],
      false,
    )
    expect(missingRequestPlan.status).toBe(400)
    expect((await missingRequestPlan.json()).error.message).toBe(
      'Missing or invalid internal Fable 5.1 effort request plan',
    )

    const refusalLogs: LogTestRecord[] = []
    __setLogTestSink((record) => refusalLogs.push(record))
    const missingAllMarkers = await send('ses_effort_missing_all', [])
    expect(missingAllMarkers.status).toBe(400)
    expect((await missingAllMarkers.json()).error.message).toBe(
      'Fable 5.1 effort marker correlation failed: expected 1, found 0',
    )
    const missingAllLog = refusalLogs.find(
      (record) => record.payload?.check === 'missing_all_markers',
    )
    expect(missingAllLog).toMatchObject({
      level: 'warn',
      channel: 'effort-history',
      message: 'refused uncorrelated Fable 5.1 request',
      payload: {
        markerCount: 1,
        resolvedPlan: true,
        plannedBoundaryId: 'msg_marked_high',
        retainedUserMessageCount: 1,
        lastUserTextBlockCount: 1,
        expectedAnchorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
    expect(JSON.stringify(missingAllLog)).not.toContain('correlation failure')

    const duplicateTransition = await send('ses_effort_duplicate_transition', [
      transitionMarker,
      transitionMarker,
      anchorMarker,
    ])
    expect(duplicateTransition.status).toBe(400)
    expect((await duplicateTransition.json()).error.message).toBe(
      'Fable 5.1 effort marker correlation failed: expected 1, found 2',
    )

    const misplacedAnchor = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-session-affinity': 'ses_effort_misplaced_anchor',
        ...(effortPlanHeader
          ? { 'x-cortexkit-effort-plan': effortPlanHeader }
          : {}),
      },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        output_config: { effort: 'high' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'correlation failure' },
              { type: 'text', text: transitionMarker },
              { type: 'text', text: anchorMarker },
            ],
          },
          { role: 'user', content: 'unexpected boundary' },
        ],
      }),
    })
    expect(misplacedAnchor.status).toBe(400)
    expect((await misplacedAnchor.json()).error.message).toBe(
      'Missing or invalid internal Fable 5.1 effort anchor placement',
    )
    expect(refusalLogs).toContainEqual({
      level: 'warn',
      channel: 'effort-history',
      message: 'refused uncorrelated Fable 5.1 request',
      payload: expect.objectContaining({
        check: 'anchor_placement',
        anchorBoundaryId: 'msg_marked_high',
        plannedBoundaryId: 'msg_marked_high',
        lastUserMessageId: null,
        anchorMessageIndex: 0,
        lastUserMessageIndex: 1,
        anchorsFound: 1,
        markerCount: 1,
        validToolContinuationSuffix: false,
        expectedAnchorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        foundAnchorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        anchorMatchesExpected: true,
      }),
    })
    expect(JSON.stringify(refusalLogs)).not.toContain(anchorMarker)
    expect(JSON.stringify(refusalLogs)).not.toContain(transitionMarker)
    expect(messagesCalled).toBe(false)
  })
})

describe('meaningful trailing assistant history', () => {
  const originalFetch = globalThis.fetch
  let restoreFallbackSelection: (() => void) | undefined

  afterEach(async () => {
    restoreFallbackSelection?.()
    restoreFallbackSelection = undefined
    globalThis.fetch = originalFetch
    __setLogTestSink(null)
    await drainSidebarWrites()
  })

  const trailingAssistantBody = () =>
    JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'earlier question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'completed private answer' }],
        },
      ],
    })

  async function expectLocalRefusal(response: Response) {
    expect(response.status).toBe(400)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: TRAILING_ASSISTANT_HISTORY_MESSAGE,
      },
    })
  }

  test('OAuth route refuses locally without model dispatch or fallback', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        fallbackOn: [400, 429],
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
      }),
    )
    const modelDispatches: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(
              Response.json({
                oauth_account: { account_uuid: 'trailing-account' },
              }),
            )
          }
          if (url.includes('/v1/messages')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            modelDispatches.push(authorization ?? '')
            // An actual provider 400 remains eligible under the explicit policy,
            // even when its error body matches the plugin's local refusal.
            if (authorization === 'Bearer sk-ant-oat01-main-access') {
              return Promise.resolve(
                Response.json(
                  {
                    type: 'error',
                    error: {
                      type: 'invalid_request_error',
                      message: TRAILING_ASSISTANT_HISTORY_MESSAGE,
                    },
                  },
                  { status: 400 },
                ),
              )
            }
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))

    const plugin = await getPlugin()
    const auth = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )

    const fallbackSelection = spyOn(
      FallbackAccountManager.prototype,
      'getUsableFallbackAccounts',
    )
    restoreFallbackSelection = () => fallbackSelection.mockRestore()
    await expectLocalRefusal(
      await auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_trailing_oauth' },
        body: trailingAssistantBody(),
      }),
    )
    expect(modelDispatches).toEqual([])
    expect(fallbackSelection).not.toHaveBeenCalled()
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).not.toBe('fallback-1')
    expect(logs).toContainEqual({
      level: 'warn',
      channel: 'transform',
      message: 'refused request ending on assistant history',
      payload: expect.objectContaining({
        check: 'meaningful_trailing_assistant',
        trailingMessageIndex: 1,
      }),
    })
    expect(JSON.stringify(logs)).not.toContain('completed private answer')

    // Control: the same fixture does fall back when the model is reached, so
    // the refusal above stayed local because of the history check.
    const control = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_trailing_oauth' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'new question' }],
      }),
    })
    expect(control.status).toBe(200)
    expect(modelDispatches).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
    expect(fallbackSelection).toHaveBeenCalled()
  })

  test('API-key route refuses locally without model dispatch', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        fallbackOn: [400, 429],
        routing: { mode: 'fallback-first' },
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        accounts: [
          {
            id: 'api-trailing',
            type: 'api',
            apiKey: 'api-trailing-key',
            baseURL: 'https://api.example.test',
            authHeader: 'x-api-key',
          },
        ],
        quota: { enabled: false } as AccountStorage['quota'],
      }),
    )
    const modelDispatches: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/messages')) {
            const headers = new Headers(init?.headers)
            modelDispatches.push(
              headers.get('x-api-key') ?? headers.get('authorization') ?? '',
            )
            // The upstream five-hour utilization header proves 100% usage.
            // Paid API-key fallback requires confirmed OAuth exhaustion;
            // selecting fallback-first alone does not permit paid requests.
            return Promise.resolve(
              new Response('{}', {
                status: 200,
                headers:
                  headers.get('authorization') ===
                  'Bearer sk-ant-oat01-main-access'
                    ? {
                        'anthropic-ratelimit-unified-representative-claim':
                          'five_hour',
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                        'anthropic-ratelimit-unified-5h-reset': '1784246400',
                        'anthropic-ratelimit-unified-7d-utilization': '0.4',
                        'anthropic-ratelimit-unified-7d-reset': '1784628000',
                      }
                    : undefined,
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))

    const plugin = await getPlugin()
    const auth = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const userEndedBody = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'new question' }],
    })

    // Warm-up: main serves this request and reports its quota as exhausted.
    await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_trailing_api' },
      body: userEndedBody,
    })
    expect(modelDispatches).toEqual(['Bearer sk-ant-oat01-main-access'])
    modelDispatches.length = 0
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).toBe('main')

    await expectLocalRefusal(
      await auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_trailing_api' },
        body: trailingAssistantBody(),
      }),
    )
    expect(modelDispatches).toEqual([])
    // The API-key route must return its local 400, not throw. A throw would
    // make routing try main and set sidebar activeId to 'main' instead of the
    // API-key account id asserted below.
    await drainSidebarWrites()
    expect(await getSidebarState()).toMatchObject({
      activeId: 'api-trailing',
      route: 'fallback-first',
    })
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        channel: 'transform',
        message: 'refused request ending on assistant history',
      }),
    )
    expect(JSON.stringify(logs)).not.toContain('completed private answer')

    // Control: a user-ended request in the same state reaches the API-key
    // account, so only the history check kept the refused request local.
    const control = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_trailing_api' },
      body: userEndedBody,
    })
    expect(control.status).toBe(200)
    expect(modelDispatches).toEqual(['api-trailing-key'])
  })
})

describe('provider.models', () => {
  beforeEach(async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
  })

  afterEach(async () => {
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    tempConfigDir = undefined
  })

  test('zeros out Anthropic model costs for OAuth auth', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        api: {
          id: 'claude-opus-4-8',
          type: 'aisdk',
          package: '@ai-sdk/anthropic',
        },
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        release_date: '2026-01-01',
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'oauth' } } as never,
    )

    expect(result?.['claude-opus-4-8']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(result?.['claude-fable-5']?.name).toBe('Claude Fable 5')
    expect(result?.['claude-fable-5']?.api?.id).toBe('claude-fable-5')
    expect(result?.['claude-fable-5']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(result?.['claude-fable-5']?.limit).toMatchObject({
      context: 1_000_000,
      output: 128_000,
    })
    expect(result?.['claude-mythos-5']?.name).toBe('Claude Mythos 5')
    expect(result?.['claude-fable-5-1']?.name).toBe('Claude Fable 5.1')
    expect(result?.['claude-fable-5']?.release_date).toBe('2026-06-09')
    expect(result?.['claude-fable-5-1']?.release_date).toBe('2026-09-01')
    expect(result?.['claude-fable-5-1']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(Object.keys(result?.['claude-fable-5-1']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(result?.['claude-fable-5-1']?.variants?.xhigh).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'xhigh',
    })
    expect(result?.['claude-mythos-5-1']?.variants).toBeUndefined()
    expect(result?.['claude-mythos-5-1']?.name).toBe('Claude Mythos 5.1')
    expect(result?.['claude-haiku-5-5']?.api?.id).toBe('claude-haiku-5-5')
    expect(result?.['claude-haiku-5-5']?.name).toBe('Claude Haiku 5.5')
    expect(result?.['claude-haiku-5-5']?.release_date).toBe('2026-10-07')
    expect(result?.['claude-haiku-5-5']?.limit).toMatchObject({
      context: 1_000_000,
      output: 128_000,
    })
    expect(result?.['claude-haiku-5-5']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(Object.keys(result?.['claude-haiku-5-5']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(result?.['claude-haiku-5-5']?.variants?.max).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'max',
    })
    expect(result?.['claude-sonnet-5-5']?.api?.id).toBe('claude-sonnet-5-5')
    expect(result?.['claude-sonnet-5-5']?.release_date).toBe('2026-09-28')
    expect(result?.['claude-sonnet-5-5']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
    expect(result?.['claude-sonnet-5-5']?.limit).toMatchObject({
      context: 1_000_000,
      output: 128_000,
    })
    expect(Object.keys(result?.['claude-sonnet-5-5']?.variants ?? {})).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(models['claude-opus-4-8'].cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
  })

  test('keeps Anthropic API-key model costs unchanged and prices Fable 5/5.1', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        api: {
          id: 'claude-opus-4-8',
          type: 'aisdk',
          package: '@ai-sdk/anthropic',
        },
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        release_date: '2026-01-01',
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'api' } } as never,
    )

    expect(result).not.toBe(models)
    expect(result?.['claude-opus-4-8']?.cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
    expect(result?.['claude-fable-5']?.api?.id).toBe('claude-fable-5')
    expect(result?.['claude-fable-5']?.cost).toEqual({
      input: 10,
      output: 50,
      cache: { read: 1, write: 12.5 },
    })
    expect(result?.['claude-fable-5-1']?.cost).toEqual({
      input: 10,
      output: 50,
      cache: { read: 0.25, write: 12.5 },
    })
    expect(result?.['claude-sonnet-5-5']?.cost).toEqual({
      input: 2,
      output: 10,
      cache: { read: 0.2, write: 2.5 },
    })
    expect(result?.['claude-haiku-5-5']?.cost).toEqual({
      input: 0.1,
      output: 0.5,
      cache: { read: 0.01, write: 0.125 },
      tiers: [
        {
          tier: { type: 'context', size: 100_000 },
          input: 0.5,
          output: 2.5,
          cache: { read: 0.05, write: 0.625 },
        },
      ],
    })
  })

  test('replaces stale Opus 5 manual-thinking variants with adaptive efforts', async () => {
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        variants: {
          high: {
            thinking: { type: 'adaptive', display: 'summarized' },
            effort: 'high',
          },
        },
      },
      'claude-opus-5': {
        id: 'claude-opus-5',
        api: { id: 'claude-opus-5' },
        variants: {
          high: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
          max: { thinking: { type: 'enabled', budgetTokens: 31_999 } },
        },
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'api' } } as never,
    )

    expect(result?.['claude-opus-5-5']?.name).toBe('Claude Opus 5.5')
    expect(result?.['claude-sonnet-5-5']?.name).toBe('Claude Sonnet 5.5')
    expect(result?.['claude-sonnet-5-5']?.variants).toEqual(
      result?.['claude-opus-5']?.variants,
    )
    expect(result?.['claude-opus-5-5']?.variants).toEqual(
      result?.['claude-opus-5']?.variants,
    )
    expect(result?.['claude-opus-5']?.variants).toEqual({
      low: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'low',
      },
      medium: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'medium',
      },
      high: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'high',
      },
      xhigh: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'xhigh',
      },
      max: {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'max',
      },
    })
    expect(models['claude-opus-5'].variants.max.thinking).toEqual({
      type: 'enabled',
      budgetTokens: 31_999,
    })
  })

  test('does not zero OAuth model costs when costZeroing is disabled', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], costZeroing: { enabled: false } }),
    )
    const plugin = await getPlugin()
    const models = {
      'claude-opus-4-8': {
        id: 'claude-opus-4-8',
        name: 'Claude Opus 4.8',
        cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
        limit: { context: 1_000_000, output: 128_000 },
        capabilities: { reasoning: true, attachment: true, toolcall: true },
        release_date: '2026-01-01',
      },
    }

    const result = await plugin.provider?.models?.(
      { models } as never,
      { auth: { type: 'oauth' } } as never,
    )

    // OAuth auth but opted out → real costs preserved, not zeroed.
    expect(result?.['claude-opus-4-8']?.cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
  })
})

describe('auth.loader', () => {
  const originalFetch = globalThis.fetch
  const originalRandom = Math.random
  const originalDateNow = Date.now

  beforeEach(async () => {
    pluginRuntimeOverrides = {}
    Math.random = originalRandom
    Date.now = originalDateNow
    resetCache1hState()
    resetDumpState()
    resetFastModeState()
    resetNotificationsForTest()
    __setInitialSidebarRoutingTestHooks(null)
    __setSidebarStateWriteTestHooks(null)
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE = 'legacy'
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
  })

  afterEach(async () => {
    await drainBeforeReset(testLifetime, async () => {
      globalThis.fetch = originalFetch
      pluginRuntimeOverrides = {}
      Math.random = originalRandom
      Date.now = originalDateNow
      resetNotificationsForTest()
      __setInitialSidebarRoutingTestHooks(null)
      __setSidebarStateWriteTestHooks(null)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
      await drainSidebarWrites()
      restoreProcessTestFiles()
      tempConfigDir = undefined
    })
  })

  test('teardown drains an interrupted body before resetting its request transport', async () => {
    const scope = new TestLifetime()
    const resume = scope.gate()
    const events: string[] = []
    let transport = () => events.push('owned-request')
    const body = scope.runBody(async () => {
      await resume.wait
      events.push('body-resumed')
      transport()
    })
    await drainBeforeReset(scope, () => {
      events.push('transport-reset')
      transport = () => events.push('network-guard')
    })
    await body
    expect(events).toEqual(['body-resumed', 'owned-request', 'transport-reset'])
  })

  test('returns empty object for non-oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'api' }),
      { models: {} },
    )
    expect(result).toEqual({})
  })

  test('remaps a non-OAuth Request body supplied without init.body', async () => {
    const previousModel = process.env.ANTHROPIC_MODEL
    process.env.ANTHROPIC_MODEL = 'proxy-model-alias'
    let auth: {
      type: string
      access?: string
      refresh?: string
      expires?: number
    } = {
      type: 'oauth',
      access: 'sk-ant-oat01-initial-oauth',
      refresh: 'initial-refresh',
      expires: Date.now() + 100_000,
    }
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-initial-oauth',
      refresh: 'initial-refresh',
      expires: auth.expires as number,
    })
    let observedBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      withNativeAdmission(async (_input: unknown, init?: RequestInit) => {
        observedBody = JSON.parse(String(init?.body))
        return new Response('{}', { status: 200 })
      }),
    ) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () => Promise.resolve(auth as never),
        {
          models: {},
        },
      )
      auth = { type: 'api' }
      await result.fetch(
        new Request(MESSAGES_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-custom-family',
            messages: [{ role: 'user', content: 'hello' }],
          }),
        }),
      )

      expect(observedBody?.model).toBe('proxy-model-alias')
    } finally {
      if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previousModel
    }
  })

  test('returns fetch wrapper for oauth auth', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
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
    expect(result.apiKey).toBe('')
    expect(result.fetch).toBeFunction()
  })

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
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: { enabled: false },
        accounts: [
          {
            id: 'work-deleted',
            type: 'oauth',
            access: 'sk-ant-oat01-work-deleted-access',
            refresh: 'work-deleted-refresh',
            expires: Date.now() + 100000,
          },
          {
            id: 'work-witness',
            type: 'oauth',
            access: 'sk-ant-oat01-work-witness-stale-access',
            refresh: 'work-witness-stale-refresh',
            expires: Date.now() + 100000,
            lastRefreshedAt: 100,
          },
        ],
      }),
    )
    const refreshStarted = deferred()
    const releaseRefresh = deferred()
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url === TOKEN_URL) {
        refreshStarted.resolve()
        return releaseRefresh.promise.then(
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
    const backgroundRefreshReady = (
      plugin as unknown as { __fallbackRefreshReady?: Promise<void> }
    ).__fallbackRefreshReady
    expect(backgroundRefreshReady).toBeInstanceOf(Promise)
    try {
      await withDeadlockGuard(
        refreshStarted.promise,
        4_000,
        'fallback refresh never reached the token stub; the eager refresh did not start',
      )
      // v1.16.0's mergeAccountsForSave unions existing+incoming accounts, so a
      // deletion must be declared explicitly via removedAccountIds — a plain
      // save without the account no longer removes it.
      await saveAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          quota: { enabled: false },
          accounts: [
            {
              id: 'work-current',
              type: 'oauth',
              access: 'sk-ant-oat01-work-current-access',
              refresh: 'work-current-refresh',
              expires: Date.now() + 100000,
            },
            {
              id: 'work-witness',
              type: 'oauth',
              access: 'sk-ant-oat01-work-witness-current-access',
              refresh: 'work-witness-current-refresh',
              expires: Date.now() + 100000,
              lastRefreshedAt: 200,
            },
          ],
        }),
        undefined,
        { removedAccountIds: ['work-deleted'] },
      )
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
      releaseRefresh.resolve()
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
      expect(
        disk?.accounts.find((account) => account.id === 'work-current'),
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
      releaseRefresh.resolve()
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
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
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
      await expectHandledCommandResponse(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      )
      // Replace the shared pool config JSON file with a directory so later
      // account reads fail instead of returning an outdated snapshot.
      const accountFile = migratedPool?.paths.config
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
    await seedSidebarRouting('fallback-b', 'fallback-first', Date.now())

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

  test('dumps direct Anthropic requests when relay is disabled', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-direct-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          dump: { enabled: true },
          quota: {
            enabled: false,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 40,
                remainingPercent: 60,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        }),
      )

      globalThis.fetch = mock(
        withNativeAdmission((_input: any, _init: any) =>
          Promise.resolve(
            new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
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

      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-direct-dump' },
        body: JSON.stringify({
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      const files = await readdir(dumpDir)
      const bodyPath = files.find((file) => file.endsWith('.body.json'))
      const metaPath = files.find((file) => file.endsWith('.meta.json'))
      const requestPath = files.find((file) => file.endsWith('.request.json'))
      expect(bodyPath).toBeString()
      expect(metaPath).toBeString()
      expect(requestPath).toBeString()
      expect(files.some((file) => file.endsWith('.relay.json'))).toBe(false)

      const body = JSON.parse(await readFile(join(dumpDir, bodyPath!), 'utf8'))
      const meta = JSON.parse(await readFile(join(dumpDir, metaPath!), 'utf8'))
      const request = JSON.parse(
        await readFile(join(dumpDir, requestPath!), 'utf8'),
      )

      expect(body.model).toBe('claude-fable-5')
      expect(meta).toMatchObject({
        transport: 'direct',
        route: 'main',
        status: 200,
        session: 'ses-direct-dump',
      })
      expect(meta.files.relay).toBeUndefined()
      expect(request).toMatchObject({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages?beta=true',
      })
      expect(request.headers.authorization).toBe('[redacted]')
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('dumps final streamed usage while retaining opening counters', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-stream-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          dump: { enabled: true },
          quota: { enabled: false },
        }),
      )
      const start = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_stream_usage',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation: {
              ephemeral_5m_input_tokens: 4,
              ephemeral_1h_input_tokens: 16,
            },
            output_tokens: 3,
          },
          diagnostics: null,
        },
      })}\n\n`
      const delta = `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1749 },
      })}\n\n`
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response(`${start}${delta}`, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
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
        headers: { 'x-session-affinity': 'ses-stream-dump' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(await response.text()).toBe(`${start}${delta}`)

      const files = await readdir(dumpDir)
      const responsePath = files.find((file) => file.endsWith('.response.json'))
      expect(responsePath).toBeString()
      expect(
        JSON.parse(await readFile(join(dumpDir, responsePath!), 'utf8')),
      ).toEqual({
        status: 200,
        message_id: 'msg_stream_usage',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 4,
            ephemeral_1h_input_tokens: 16,
          },
          output_tokens: 1749,
        },
        diagnostics: null,
        stop_reason: 'end_turn',
        stream_complete: true,
      })
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
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
    if (!migratedPool) throw new Error('Sidebar fixture did not migrate')
    const fixtureRuntime = createNativeAccountRuntime({
      paths: migratedPool.paths,
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

  test('cachekeep lists tracked sessions across OpenCode plugin instances', async () => {
    const nowHour = new Date().getHours()
    const startHour = (nowHour + 23) % 24
    const endHour = (nowHour + 1) % 24
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, startHour, endHour },
      }),
    )

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
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
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
      headers: { 'x-session-affinity': 'session-1' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const secondPlugin = await getPlugin(createMockClient())
    const secondResult = await secondPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await secondResult.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-2' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const registryDirectory =
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
    if (!registryDirectory)
      throw new Error('missing cachekeep registry directory')
    for (let attempt = 0; attempt < 50; attempt++) {
      const entries = await readdir(registryDirectory).catch(() => [])
      if (entries.filter((entry) => entry.endsWith('.json')).length >= 2) break
      await Bun.sleep(10)
    }
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain('Tracked sessions: 2')
    expect(latestCall?.body.parts[0]?.text).toContain(
      'Sessions:\n- session-1\n- session-2',
    )
  })

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

  test('routes to API-key fallback after main OAuth returns 429 and strips server fallback fields from the custom provider request', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
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
    expect(requests[1]?.beta?.split(',')).not.toContain(
      SERVER_SIDE_FALLBACK_BETA,
    )
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

  test('fallback-first adopts legacy persisted main quota for sidebar without refetching', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          mainQuota: {
            five_hour: { usedPercent: 6, remainingPercent: 94 },
            seven_day: { usedPercent: 75, remainingPercent: 25 },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('old-main-access'),
        } as AccountStorage['quota'],
      }),
    )

    const authorizations: string[] = []
    let mainQuotaCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
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

    const state = await waitForSidebarState(
      (candidate) =>
        candidate.activeId === 'fallback-1' &&
        candidate.main.quota?.five_hour?.usedPercent === 6,
    )
    expect(state.route).toBe('fallback-first')
    expect(state.main.quota?.seven_day?.usedPercent).toBe(75)
    expect(mainQuotaCalls).toBe(0)
    expect(authorizations[0]).toBe('Bearer sk-ant-oat01-fallback-access')
  })

  test('fetch wrapper sets OAuth headers and prefixes tools', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-my-access-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })

    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

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
        capturedHeaders = init?.headers
        capturedBody = init?.body
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-abc' },
      body,
    })

    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!.get('authorization')).toBe(
      'Bearer sk-ant-oat01-my-access-token',
    )
    expect(capturedHeaders!.get('x-api-key')).toBeNull()
    expect(capturedHeaders!.get('x-session-affinity')).toBeNull()
    expect(capturedHeaders!.get('x-opencode-session')).toBeNull()
    expect(capturedHeaders!.get('anthropic-beta')).toContain('oauth-2025-04-20')

    const parsedBody = JSON.parse(capturedBody!)
    // Tool name should be prefixed
    expect(parsedBody.tools[0].name).toBe('mcp_Bash')
    // Three-block layout: billing header, identity, rest
    expect(parsedBody.system).toHaveLength(3)
    expect(parsedBody.system[0].text).toContain('x-anthropic-billing-header')
    expect(parsedBody.system[1].text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    )
    expect(parsedBody.system[2].text).toBe('You are a helpful assistant.')
    // User message is untouched
    expect(parsedBody.messages[0].content).toBe('hello world test message')
  })

  test('uses configured relay instead of uploading full body directly', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: true,
          transport: 'http',
        },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )

    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined
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
        capturedUrl = url
        capturedBody = init?.body
        capturedHeaders = new Headers(init?.headers)
        return Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-abc' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        system: 'system',
      }),
    })

    expect(capturedUrl).toBe('https://relay.example.test/')
    expect(capturedHeaders?.get('x-relay-token')).toBe('relay-token')
    const payload = JSON.parse(capturedBody!)
    expect(payload).toMatchObject({
      mode: 'full_sync',
      affinity: 'session-abc',
      upstream: {
        url: 'https://api.anthropic.com/v1/messages?beta=true',
      },
    })
    expect(payload.upstream.headers['x-session-affinity']).toBeUndefined()
    expect(payload.upstream.headers['x-opencode-session']).toBeUndefined()
    expect(payload.body.length).toBeGreaterThan(0)
  })

  test('reloads relay config from sidecar after plugin startup', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-my-access-token',
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
        return Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await updatePoolRelay({
      enabled: true,
      url: 'https://relay.example.test',
      token: 'relay-token',
      fallbackToDirect: true,
      transport: 'http',
    })

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-abc' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        system: 'system',
      }),
    })

    expect(capturedUrl).toBe('https://relay.example.test/')
  })

  test('sidebar relay transport reflects current sidecar storage', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: true,
          transport: 'http',
        },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )

    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        ),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await updatePoolRelay({ transport: 'websocket' })

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: new Uint8Array([123, 125]),
    })

    const state = await waitForSidebarState(
      (value) => value.relay?.transport === 'websocket',
    )
    expect(state.relay).toEqual({ enabled: true, transport: 'websocket' })
  })

  test('registers /claude and handles cache settings with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)
    const config: { command?: Record<string, unknown> } = {}

    await plugin.config(config)

    expect(config.command?.claude).toMatchObject({
      template: 'claude',
      description: expect.stringContaining('Claude accounts'),
    })
    for (const command of COMMAND_MODAL_NAMES) {
      expect(config.command?.[command]).toBeUndefined()
    }

    // The menu action's reply is the apply result the TUI shows.
    const enabled = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Cache',
      actionId: 'cache-on',
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.text).toContain('## Claude Cache Enabled')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(latestIgnoredReply(mockClient)).toContain('- Enabled: enabled')

    expect((await readNativeSettings()).claudeCache).toEqual({
      enabled: true,
      mode: 'explicit',
    })
  })

  test('config hook registers only /claude and retires owned aliases without clobbering foreign commands', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const plugin = await getPlugin()
    const preExisting = { template: 'other-plugin-cmd', description: 'foreign' }
    const result: { command?: Record<string, unknown> } = {
      command: {
        'other-plugin-cmd': preExisting,
        ...Object.fromEntries(
          COMMAND_MODAL_NAMES.map((name) => [
            name,
            {
              template: name,
              description: 'previous plugin registration',
            },
          ]),
        ),
      },
    }
    await plugin.config(result)

    expect(result.command?.['other-plugin-cmd']).toEqual(preExisting)
    expect(result.command?.claude).toMatchObject({ template: 'claude' })
    for (const name of COMMAND_MODAL_NAMES) {
      expect(result.command?.[name]).toBeUndefined()
    }
    expect(Object.keys(result.command ?? {}).sort()).toEqual([
      'claude',
      'other-plugin-cmd',
    ])
    await plugin.dispose?.()
  })

  test('handles /claude-start by injecting one visible synthetic prompt', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-start', {
      sectionId: 'Extras',
      actionId: 'start-fire',
    })
    expect(result.ok).toBe(true)

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: {
          calls: Array<[{ body: { parts: Array<Record<string, unknown>> } }]>
        }
      }
    ).mock.calls as Array<
      [
        {
          path: { id: string }
          body: { noReply: boolean; parts: Array<Record<string, unknown>> }
        },
      ]
    >
    const startCall = promptCalls
      .map(([call]) => call)
      .find((call) => call.body.parts[0]?.synthetic === true)
    expect(startCall).toEqual({
      path: { id: 'session-start' },
      body: {
        noReply: false,
        parts: [
          {
            type: 'text',
            text: '[lane start] — automated cache warm; no response needed.',
            synthetic: true,
          },
        ],
      },
    })
  })

  test('handles /claude-cachekeep command and persists window', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)

    const windowed = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cachekeep-window',
      values: { startHour: 9, endHour: 23 },
    })
    expect(windowed.ok).toBe(true)
    expect(windowed.text).toContain('## Claude Cache Keep Enabled')
    expect(windowed.text).toContain('Schedule: 09-23')
    expect(windowed.text).toContain('Hybrid active: yes')

    expect((await readNativeSettings()).cacheKeep).toEqual({
      enabled: true,
      always: false,
      startHour: 9,
      endHour: 23,
    })

    const always = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cachekeep-always',
    })
    expect(always.ok).toBe(true)
    expect((await readNativeSettings()).cacheKeep).toEqual({
      enabled: true,
      always: true,
    })
  })

  test('registers and handles /claude-fast slash command with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)

    // The menu action's reply is the apply result the TUI shows.
    const enabled = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Extras',
      actionId: 'fast-on',
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.text).toContain('## Claude Fast Mode Enabled')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(latestIgnoredReply(mockClient)).toContain('- Enabled: enabled')

    expect((await readNativeSettings()).claudeFast).toEqual({ enabled: true })
  })

  test('handles /claude-routing slash command and persists routing mode', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)

    const updated = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Routing',
      actionId: 'routing-mode',
      values: { mode: 'sticky-balanced' },
    })
    expect(updated.ok).toBe(true)
    expect(updated.text).toContain('Mode updated to `sticky-balanced`.')

    // Without a connected TUI, /claude replies with an ignored status message.
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    expect(latestIgnoredReply(mockClient)).toContain(
      '- Mode: `sticky-balanced`',
    )

    const reset = await applyMenuAction(plugin, 'session-menu', {
      sectionId: 'Routing',
      actionId: 'routing-reset',
    })
    expect(reset.ok).toBe(true)
    expect(reset.text).toContain('Claude Routing Assignment Reset')

    expect((await readNativeSettings()).routing).toEqual({
      mode: 'sticky-balanced',
    })
  })

  test('hidden slash-command replies preserve previous assistant model and variant', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient([
      {
        info: {
          role: 'user',
          agent: 'Default Agent',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variant: 'low',
          },
        },
      },
      {
        info: {
          role: 'assistant',
          agent: 'Alfonso - CTO',
          providerID: 'anthropic',
          modelID: 'claude-opus-4-7',
          variant: 'xhigh',
        },
      },
    ])
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(mockClient.session.messages).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      query: { limit: 100 },
    })
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        agent: 'Alfonso - CTO',
        model: {
          providerID: 'anthropic',
          modelID: 'claude-opus-4-7',
        },
        variant: 'xhigh',
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('## Claude Cache'),
          },
        ],
      },
    })
  })

  test('handles /claude-dump slash command and persists dump capture', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Diagnostics',
      actionId: 'dump-on',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('## Claude Dump Enabled')

    expect((await readNativeSettings()).dump).toEqual({ enabled: true })
  })

  test('handles /claude-cache mode command and persists cache strategy', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)

    const result = await applyMenuAction(plugin, 'session-1', {
      sectionId: 'Cache',
      actionId: 'cache-mode',
      values: { mode: 'hybrid' },
    })

    expect((await readNativeSettings()).claudeCache).toEqual({
      enabled: true,
      mode: 'hybrid',
    })

    expect(result.ok).toBe(true)
    expect(result.text).toContain('Mode updated to `hybrid`.')
  })

  test('handles /claude-quota before auth loader has run', async () => {
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('auth loader has not run yet'),
          },
        ],
      },
    })
  })

  test('/claude-quota shows live main and fallback quotas', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'fallback-1',
            label: 'fallback personal',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            quota: {
              five_hour: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: 1,
              },
              seven_day: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: 1,
              },
            },
          },
        ],
      }),
    )
    const mockClient = createMockClient()
    const seenTokens: string[] = []

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('/api/oauth/usage')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            if (authorization) seenTokens.push(authorization)
            const utilization =
              authorization === 'Bearer sk-ant-oat01-main-access' ? 25 : 40
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  five_hour: { utilization },
                  seven_day: { utilization: utilization + 10 },
                }),
                { status: 200 },
              ),
            )
          }

          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
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

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(seenTokens).toContain('Bearer sk-ant-oat01-main-access')
    expect(
      seenTokens.filter(
        (token) => token === 'Bearer sk-ant-oat01-fallback-access',
      ).length,
    ).toBeGreaterThanOrEqual(1)
    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const text = promptCalls.at(-1)?.[0]?.body.parts[0]?.text
    expect(text).toContain('## Claude Quotas')
    expect(text).toContain('### OpenCode anthropic (main)')
    expect(text).toContain('### fallback personal (fallback)')
    expect(text).toContain('5h: 75% remaining')
    expect(text).toContain('1w: 50% remaining')
  })

  test('/claude-quota bounds stalled profile hydration without hiding quota output', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      bindMainQuotaToAccount(
        createFallbackStorage({
          accounts: [],
          main: {
            type: 'opencode',
            provider: 'anthropic',
            profile: {
              checkedAt: checkedAt - 8 * 24 * 60 * 60_000,
              tier: 'default_claude_free',
              orgType: 'claude_free',
            },
          },
          quota: {
            enabled: true,
            mainQuota: {
              five_hour: { usedPercent: 25, remainingPercent: 75, checkedAt },
              seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt },
              checkedAt,
            },
          },
        }),
      ),
    )
    const mockClient = createMockClient()
    let profileSignal: AbortSignal | undefined
    let usageCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/profile')) {
            profileSignal = init?.signal ?? undefined
            return new Promise<Response>((_resolve, reject) => {
              profileSignal?.addEventListener(
                'abort',
                () => reject(profileSignal?.reason),
                { once: true },
              )
            })
          }
          if (url.includes('/api/oauth/usage')) {
            usageCalls++
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 25 },
                seven_day: { utilization: 50 },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const startedAt = performance.now()
    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(performance.now() - startedAt).toBeLessThan(4_000)
    expect(profileSignal?.aborted).toBe(true)
    expect(usageCalls).toBe(0)
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string
    expect(text).toContain('## Claude Quotas')
    expect(text).toContain('5h: 75% remaining')
    expect(text).not.toContain('Max 20x')
  }, 5_000)

  test('/claude-quota renders hydrated profile without waiting for profile persistence', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 25 },
              seven_day: { utilization: 50 },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const pool = migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    try {
      expect((await reader.authorizeLocal('main')).status).toBe('usable')
    } finally {
      reader.close()
    }
    const locked = bodyLifetime().gate()
    const release = bodyLifetime().gate()
    // Block the actual native profile destination, not the retired config
    // file. Credential validation completed before acquiring this writer.
    const writer = withLock(
      pool.paths.runtime,
      {
        name: 'native-runtime',
        ttlMs: 10_000,
        timeoutMs: 15_000,
        renew: true,
      },
      async () => {
        locked.open()
        await release.wait
      },
    )
    bodyLifetime().trackDetached(writer)
    await locked.wait

    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    try {
      const rendered = await Promise.race([
        command.then(() => true),
        Bun.sleep(100).then(() => false),
      ])

      expect(rendered).toBe(true)
      expect(profileCalls).toBe(1)
      const text = (mockClient.session.promptAsync as any).mock.calls.at(
        -1,
      )?.[0]?.body.parts[0]?.text as string
      expect(text).toContain('Max 20x')
      expect((await readAccountStorage())?.main?.profile).toBeUndefined()
    } finally {
      release.open()
      await writer
      await command
    }

    const persistedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.tier === 'default_claude_max_20x',
    )
    expect(persistedStorage?.main?.profile?.tier).toBe('default_claude_max_20x')
  })

  test('profile fetch runs once per account per boot and persists the result', async () => {
    await useTempAccountFile(createFallbackStorage())
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          const auth = new Headers(init?.headers).get('authorization') ?? ''
          if (url.includes('/api/oauth/profile')) {
            profileCalls.push(auth)
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: auth.includes('fallback')
                    ? 'claude_team'
                    : 'claude_max',
                  rate_limit_tier: auth.includes('fallback')
                    ? 'default_claude_max_5x'
                    : 'default_claude_max_20x',
                },
              }),
            )
          }
          if (url.includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 20 },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    for (let call = 0; call < 2; call++) {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      if (call === 0) {
        await waitForAccountStorage(
          (storage) =>
            storage?.main?.profile?.tier === 'default_claude_max_20x' &&
            (storage.accounts[0] as OAuthAccount | undefined)?.profile?.tier ===
              'default_claude_max_5x',
        )
      }
    }

    // Independent account hydration may finish in either order. Require
    // exactly one request per account, including after the second status read.
    expect(profileCalls.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    const loaded = await readAccountStorage()
    expect(loaded?.main?.profile?.tier).toBe('default_claude_max_20x')
    expect((loaded?.accounts[0] as any)?.profile?.tier).toBe(
      'default_claude_max_5x',
    )
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string
    expect(text).toContain('Max 20x')
    expect(text).toContain('Max 5x')
  })

  test('fresh profile under seven days skips fetch', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(
        Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      )
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('unbound legacy profile is not adopted by a different credential', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-old-access'),
          },
        },
      }),
      {
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 100000,
      },
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          (() => {
            if (extractUrl(input).includes('/api/oauth/profile')) {
              profileCalls++
              return new Response('failed', { status: 500 })
            }
            return new Response('ok')
          })(),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-new-access',
          refresh: 'new-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    // An old access-token fingerprint cannot prove the replacement account's
    // tier. A failed fresh lookup must not restore that unclaimed profile.
    expect(text).not.toContain('Max 20x')
    expect(profileCalls).toBe(1)
    expect((await readAccountStorage())?.main?.profile).toBeUndefined()
  })

  test('in-flight hydration is shared across access-token rotation', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-a',
      refresh: 'refresh-sk-ant-oat01-token-a',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    const firstProfile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (!extractUrl(input).includes('/api/oauth/profile')) {
          return Promise.resolve(new Response('ok'))
        }
        profileCalls++
        if (profileCalls === 1) {
          profileStarted.raise()
          return firstProfile.response
        }
        return Promise.resolve(
          Response.json({
            organization: {
              organization_type: 'claude_team',
              rate_limit_tier: 'default_claude_max_5x',
            },
          }),
        )
      }),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const firstCommand = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await profileStarted.raised

    // Another OpenCode process refreshes the main login while the first
    // profile request is still in flight.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-token-b',
      refresh: 'refresh-sk-ant-oat01-token-b',
      expires: Date.now() + 100000,
    })
    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await Bun.sleep(25)
    firstProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_team',
          rate_limit_tier: 'default_claude_max_5x',
        },
      }),
    )
    await firstCommand
    await command

    expect(profileCalls).toBe(1)
  })

  test('same main token keeps a fresh bound profile without refetching', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            accountIdentity: syntheticMainAccountUuid,
            providerAccountUuid: syntheticMainAccountUuid,
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
    expect((await readAccountStorage())?.main?.profile?.tier).toBe(
      'default_claude_max_20x',
    )
  })

  test('boot profile hydration publishes tier labels to the sidebar', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    expect(
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION,
    ).toBeUndefined()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
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
    const state = await waitForSidebarState(
      (value) => value.main.tierLabel === 'Max 20x',
    )

    expect(state.main.tierLabel).toBe('Max 20x')
    expect(profileCalls).toBe(1)
  })

  test('late fallback profile hydration cannot restore rotated credentials', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({
        quota: { enabled: false },
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            accountIdentity: syntheticMainAccountUuid,
            providerAccountUuid: syntheticMainAccountUuid,
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        },
        accounts: [
          {
            id: 'fb',
            type: 'oauth',
            access: 'sk-ant-oat01-old-access',
            refresh: 'old-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            lastRefreshedAt: 100,
          },
        ],
      }),
    )
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await profileStarted.raised
    await drainSidebarWrites()

    const pool = migratedPool
    if (!pool) throw new Error('Expected migrated pool')
    const reader = createNativeAccountRuntime({
      paths: pool.paths,
      host: 'opencode',
    })
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')
    try {
      const before = await reader.captureLocalSubject('fb')
      loginIssues('sk-ant-oat01-old-access', 'sk-ant-oat01-new-access')
      await refreshPoolLoginElsewhere('fb', {
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      })
      const rotated = await reader.captureLocalSubject('fb')
      expect(rotated.binding.identity).toBe(before.binding.identity)
      expect(rotated.binding.credentialEpoch).toBe(
        before.binding.credentialEpoch,
      )
      expect(rotated.version?.accessFingerprint).not.toBe(
        before.version?.accessFingerprint,
      )
      profile.release(
        Response.json({
          organization: {
            organization_type: 'claude_team',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
      )
      // Profile metadata still requires its captured token version. The late
      // response must not replace credentials or publish stale metadata.
      await waitForLogRecord(
        records,
        (record) =>
          record.channel === 'quota' &&
          record.message === 'failed to save account profile' &&
          record.payload?.account === 'fb',
        'stale fallback profile publication refusal',
      )
      await drainSidebarWrites()
      const after = await reader.captureLocalSubject('fb')
      expect(after).toEqual(rotated)
      const snapshot = await reader.read()
      expect(
        snapshot.accounts.find((account) => account.id === 'fb')?.profile,
      ).toBeUndefined()
      const stored = await createNativePoolStore({
        paths: pool.paths,
        quota: nativeQuotaCodec,
      }).read()
      expect(stored.status).toBe('ready')
      const credential =
        stored.status === 'ready'
          ? stored.rows.find((row) => row.id === rotated.binding.rowId)
              ?.credential
          : undefined
      expect(credential).toMatchObject({
        type: 'oauth',
        access: 'sk-ant-oat01-new-access',
        refresh: 'new-refresh',
      })
      expect(profileCalls).toBe(1)
    } finally {
      profile.release(new Response('cancelled', { status: 499 }))
      reader.close()
      __setLogTestSink(null)
      setLogLevel('info')
    }
  })

  test('late main profile hydration cannot replace a rotated-token profile', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const oldLogin = {
      access: 'sk-ant-oat01-old-main-access',
      refresh: 'refresh-sk-ant-oat01-old-main-access',
      expires: Date.now() + 100_000,
    }
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), oldLogin)
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...oldLogin }),
      { models: {} },
    )
    await profileStarted.raised
    await drainSidebarWrites()
    const initialSidebarUpdatedAt = (await getSidebarState()).lastUpdated

    // Another OpenCode process refreshes the main login, then records a newer
    // profile for the rotated credential, while this plugin's profile request
    // for the old access token is still in flight.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-new-main-access',
      refresh: 'refresh-sk-ant-oat01-new-main-access',
      expires: Date.now() + 100_000,
    })
    const rotated = await readAccountStorage()
    if (!rotated) throw new Error('expected account storage')
    await publishPoolMetadata('main', (identity) => ({
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: Date.now() + 10_000,
        accountIdentity: identity,
      },
    }))
    await Bun.sleep(2)
    profile.release(
      Response.json({
        organization: {
          organization_type: 'claude_team',
          rate_limit_tier: 'default_claude_max_5x',
        },
      }),
    )
    await waitForSidebarState(
      (state) => state.lastUpdated > initialSidebarUpdatedAt,
    )

    expect((await readAccountStorage())?.main?.profile).toMatchObject({
      tier: 'default_claude_max_20x',
      accountIdentity: rotated.mainAccountId,
    })
  })

  test('delayed boot hydration preserves a live fallback sidebar route', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    const mainProfile = heldResponse()
    const mainProfileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          const authorization = new Headers(init?.headers).get('authorization')
          if (
            url.includes('/api/oauth/profile') &&
            authorization === 'Bearer sk-ant-oat01-main-access'
          ) {
            mainProfileStarted.raise()
            return mainProfile.response
          }
          if (url.includes('/api/oauth/profile')) {
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: 'claude_team',
                  rate_limit_tier: 'default_claude_max_5x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
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
    await mainProfileStarted.raised

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await waitForSidebarState(
      (state) =>
        state.activeId === 'fallback-1' && state.route === 'fallback-first',
    )
    mainProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )

    const hydratedState = await waitForSidebarState(
      (state) => state.main.tierLabel === 'Max 20x',
    )
    expect(hydratedState).toMatchObject({
      activeId: 'fallback-1',
      route: 'fallback-first',
    })
  })

  test('profile hydration keeps its plugin-scoped fetch across test turnover', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage())
    const mainProfile = heldResponse()
    const mainProfileStarted = lifetimeSignal()
    const firstFetchCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const authorization = new Headers(
            input instanceof Request ? input.headers : init?.headers,
          ).get('authorization')
          if (extractUrl(input).includes('/api/oauth/usage')) {
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 25 },
                seven_day: { utilization: 30 },
              }),
            )
          }
          firstFetchCalls.push(authorization ?? '')
          if (authorization === 'Bearer sk-ant-oat01-main-access') {
            mainProfileStarted.raise()
            return mainProfile.response
          }
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_team',
                rate_limit_tier: 'default_claude_max_5x',
              },
            }),
          )
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
    await mainProfileStarted.raised

    const nextTestFetch = mock(() => Promise.resolve(new Response('ok')))
    globalThis.fetch = nextTestFetch as unknown as typeof fetch
    mainProfile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )
    await waitForSidebarState(
      (state) => state.fallbacks[0]?.tierLabel === 'Team · Max 5x',
    )

    expect(firstFetchCalls.toSorted()).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(nextTestFetch).not.toHaveBeenCalled()
  })

  test('mock-environment opt-out prevents boot profile network calls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(new Response('ok'))
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
    await Bun.sleep(20)

    expect(profileCalls).toBe(0)
  })

  test('mock-environment opt-out prevents command profile network calls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }),
        )
      }
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
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

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('boot hydration publishes storage reloaded after the profile await', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const profile = heldResponse()
    const profileStarted = lifetimeSignal()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileStarted.raise()
          return profile.response
        }
        return Promise.resolve(new Response('ok'))
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
    await profileStarted.raised

    const storage = await readAccountStorage()
    if (!storage?.quota) throw new Error('expected quota storage')
    const backoff = {
      message: 'Claude quota check failed: 429 — rate limited',
      checkedAt: Date.now(),
      nextRetryAt: Date.now() + 60_000,
      retryCount: 1,
    }
    // Another OpenCode process records a quota backoff for the main account
    // while this plugin's boot profile request is still in flight.
    await publishPoolMetadata('main', () => ({
      lastQuotaRefreshError: backoff,
    }))
    profile.release(
      Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      }),
    )

    const state = await waitForSidebarState(
      (value) => value.main.tierLabel === 'Max 20x',
    )
    expect(state.main.quotaBackedOff).toBe(true)
    // The stored backoff keeps its retry schedule; free-form provider text is
    // not stored, so no credential fragment can be published with it.
    const stored = (await readAccountStorage())?.quota?.mainLastQuotaApiError
    expect(stored).toEqual(
      expect.objectContaining({
        checkedAt: backoff.checkedAt,
        nextRetryAt: backoff.nextRetryAt,
        retryCount: backoff.retryCount,
      }),
    )
    expectNoCredentialFragment(stored)
  })

  test('token rotation reuses the profile for the same account identity', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-a',
      refresh: 'refresh-sk-ant-oat01-token-a',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            profileCalls.push(authorization ?? '')
            const firstToken = authorization?.includes('token-a')
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: firstToken ? 'claude_team' : 'claude_max',
                  rate_limit_tier: firstToken
                    ? 'default_claude_max_5x'
                    : 'default_claude_max_20x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        },
      ),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      return (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
        ?.body.parts[0]?.text as string
    }

    expect(await showAccounts()).toContain('Team · Max 5x')
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.accountIdentity === storage?.mainAccountId,
    )
    // Another OpenCode process refreshes the main login of the same account.
    await refreshPoolMainElsewhere({
      access: 'sk-ant-oat01-token-b',
      refresh: 'refresh-sk-ant-oat01-token-b',
      expires: Date.now() + 100000,
    })
    expect(await showAccounts()).toContain('Team · Max 5x')
    expect(await showAccounts()).toContain('Team · Max 5x')

    expect(profileCalls).toEqual(['Bearer sk-ant-oat01-token-a'])
    expect((await readAccountStorage())?.main?.profile?.accountIdentity).toBe(
      (await readAccountStorage())?.mainAccountId,
    )
  })

  test('expired profile TTL triggers a fresh hydration in the same process', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const originalDateNow = Date.now
    let now = 1_000_000
    let profileCalls = 0
    Date.now = () => now
    try {
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            profileCalls++
            return Promise.resolve(
              Response.json({
                organization: {
                  organization_type: 'claude_max',
                  rate_limit_tier: 'default_claude_max_20x',
                },
              }),
            )
          }
          return Promise.resolve(new Response('ok'))
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin(mockClient)
      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: now + PROFILE_TTL_MS * 3,
          }),
        { models: {} },
      )
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      const showAccounts = async () => {
        await expect(
          plugin['command.execute.before']({
            command: 'claude',
            arguments: '',
            sessionID: 'session-1',
          }),
        ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
      }

      await showAccounts()
      await waitForAccountStorage(
        (storage) => storage?.main?.profile?.checkedAt === now,
      )
      now += PROFILE_TTL_MS + 1
      await showAccounts()

      expect(profileCalls).toBe(2)
      const refreshedStorage = await waitForAccountStorage(
        (storage) => storage?.main?.profile?.checkedAt === now,
      )
      expect(refreshedStorage?.main?.profile?.checkedAt).toBe(now)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('completed profile hydration does not refetch later token generations', async () => {
    const firstLogin = {
      access: 'sk-ant-oat01-token-0',
      refresh: 'refresh-sk-ant-oat01-token-0',
      expires: Date.now() + 100000,
    }
    await useTempAccountFile(
      createFallbackStorage({ accounts: [] }),
      firstLogin,
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      }),
    ) as unknown as typeof fetch
    // The main login has served before, so the pool already knows which
    // account it belongs to; a refresh elsewhere then stays on that account.
    await poolMainAccess()
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...firstLogin }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    }

    await showAccounts()
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.accountIdentity === storage?.mainAccountId,
    )
    // Each generation is a refresh of the same account in another process,
    // which rotates the pool's main access token.
    for (let generation = 1; generation <= 66; generation++) {
      await refreshPoolMainElsewhere({
        access: `sk-ant-oat01-token-${generation}`,
        refresh: `refresh-sk-ant-oat01-token-${generation}`,
        expires: Date.now() + 100000,
      })
      await showAccounts()
    }
    await showAccounts()

    expect(profileCalls).toBe(1)
  })

  test('stale profile refreshes on display', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        main: {
          type: 'opencode',
          provider: 'anthropic',
          profile: {
            tier: 'old',
            orgType: 'claude_max',
            checkedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          profileCalls++
          return Promise.resolve(
            Response.json({
              organization: {
                organization_type: 'claude_max',
                rate_limit_tier: 'default_claude_max_20x',
              },
            }),
          )
        }
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 20 },
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(1)
    const refreshedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.tier === 'default_claude_max_20x',
    )
    expect(refreshedStorage?.main?.profile?.tier).toBe('default_claude_max_20x')
  })

  test('profile fetch failure is silent and label is omitted', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          extractUrl(input).includes('/api/oauth/profile')
            ? new Response('failed', { status: 500 })
            : Response.json({
                five_hour: { utilization: 10 },
                seven_day: { utilization: 20 },
              }),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')

    try {
      await expect(
        plugin['command.execute.before']({
          command: 'claude',
          arguments: '',
          sessionID: 'session-1',
        }),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    } finally {
      __setLogTestSink(null)
      setLogLevel('info')
    }
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    expect(text).not.toContain('Max 20x')
    expect(
      records.filter(
        (record) =>
          record.level === 'debug' &&
          record.channel === 'quota' &&
          record.message === 'failed to hydrate account profile' &&
          record.payload?.account === 'main',
      ),
    ).toHaveLength(1)
  })

  test('profile persistence failure does not block account display', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) =>
        Promise.resolve(
          extractUrl(input).includes('/api/oauth/profile')
            ? Response.json({
                organization: {
                  organization_type: 'claude_max',
                  rate_limit_tier: 'default_claude_max_20x',
                },
              })
            : new Response('ok'),
        ),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
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
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const statePath = getAccountStatePath(
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
    )
    const stateDir = dirname(statePath)
    await chmod(stateDir, 0o555)
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    setLogLevel('debug')

    let commandError: unknown
    try {
      await plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      })
    } catch (error) {
      commandError = error
    } finally {
      await chmod(stateDir, 0o755)
      __setLogTestSink(null)
      setLogLevel('info')
    }
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text as string

    expect(commandError).toBeInstanceOf(Error)
    expect((commandError as Error).message).toContain(
      '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__',
    )
    expect(text).toContain('Max 20x')
    expect(
      records.filter(
        (record) =>
          record.level === 'debug' &&
          record.channel === 'quota' &&
          record.message === 'failed to persist account profile',
      ),
    ).toHaveLength(1)
  })

  test('ordinary model request never calls the profile endpoint', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
        return Promise.resolve(new Response('ok'))
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

    expect(profileCalls).toBe(0)
  })

  test('persistent claudeFast setting makes fetch wrapper request fast mode', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeFast: { enabled: true },
      }),
      {
        access: 'sk-ant-oat01-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )

    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined
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
        capturedHeaders = init?.headers
        capturedBody = init?.body
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

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedHeaders?.get('anthropic-beta')).toContain(
      'fast-mode-2026-02-01',
    )
    expect(JSON.parse(capturedBody!).speed).toBe('fast')
  })

  test.each(['claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-5'])(
    'persistent claudeFast setting skips unsupported %s',
    async (model) => {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          claudeFast: { enabled: true },
        }),
        {
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        },
      )

      let capturedHeaders: Headers | undefined
      let capturedBody: string | undefined
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
          capturedHeaders = init?.headers
          capturedBody = init?.body
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

      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(capturedHeaders?.get('anthropic-beta')).not.toContain(
        'fast-mode-2026-02-01',
      )
      expect(JSON.parse(capturedBody!).speed).toBeUndefined()
    },
  )

  test('/claude-cache on makes fetch wrapper set ttl on existing cache controls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-my-access-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
    let capturedBody: string | undefined
    const mockClient = createMockClient()

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
        capturedBody = init?.body
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient, tempConfigDir)
    expect(
      (
        await applyMenuAction(plugin, 'session-1', {
          sectionId: 'Cache',
          actionId: 'cache-on',
        })
      ).ok,
    ).toBe(true)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello world test message' }],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('persistent claudeCache setting does not apply to subagent requests with parent session header', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
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
          capturedBody = String(init?.body)
          capturedHeaders = new Headers(init?.headers)
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-parent-session-id': 'parent-session' },
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello world test message' }],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.system[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(capturedHeaders?.has('x-parent-session-id')).toBe(false)
  })

  test('persistent hybrid claudeCache mode rewrites cache controls for main session requests', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    let capturedBody: string | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
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
          capturedBody = String(init?.body)
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: 'Magic Context history' },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'recent',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
          { role: 'user', content: 'follow up' },
        ],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.cache_control).toBeUndefined()
    expect(parsedBody.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(parsedBody.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(parsedBody.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

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
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
      }),
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

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'background-refresh-new',
              access_token: 'sk-ant-oat01-background-access-new',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

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
    await waitForMockCall(mockClient.auth.set)

    expect(mockClient.auth.set).toHaveBeenCalledWith({
      path: { id: 'anthropic' },
      body: {
        type: 'oauth',
        refresh: 'background-refresh-new',
        access: 'sk-ant-oat01-background-access-new',
        expires: expect.any(Number),
      },
    })
  })

  test('background refresh retries after a permanent main backoff belongs to an older refresh token', async () => {
    const now = Date.now()
    await useTempAccountFile(
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
    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          Response.json({
            refresh_token: 'refreshed-refresh',
            access_token: 'sk-ant-oat01-refreshed-access',
            expires_in: 8 * 60 * 60,
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

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
    await waitForMockCall(mockClient.auth.set)

    expect(tokenRefreshCalls).toBe(1)
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  })

  test('reset-backoff clears a legacy main latch before the next background refresh', async () => {
    const now = Date.now()
    await useTempAccountFile(
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
            status: 400,
            permanent: true,
          },
        },
      }),
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
    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/v1/oauth/token')) {
        tokenRefreshCalls += 1
        return Promise.resolve(
          Response.json({
            refresh_token: 'refreshed-refresh',
            access_token: 'sk-ant-oat01-refreshed-access',
            expires_in: 8 * 60 * 60,
          }),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir, {
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
      (
        await applyMenuAction(plugin, 'session-1', {
          sectionId: 'Accounts',
          actionId: 'reset-backoff',
        })
      ).ok,
    ).toBe(true)
    for (const handler of intervalHandlers) handler()
    await waitForMockCall(mockClient.auth.set)

    expect(tokenRefreshCalls).toBe(1)
    expect(
      (await readAccountStorage())?.refresh?.mainLastRefreshError,
    ).toBeUndefined()
  })

  test('background refresh uses a four-hour minimum window for main oauth', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
      }),
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

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'early-refresh-new',
              access_token: 'sk-ant-oat01-early-access-new',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

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
    await waitForMockCall(mockClient.auth.set)

    expect(mockClient.auth.set).toHaveBeenCalledWith({
      path: { id: 'anthropic' },
      body: {
        type: 'oauth',
        refresh: 'early-refresh-new',
        access: 'sk-ant-oat01-early-access-new',
        expires: expect.any(Number),
      },
    })
  })

  test('fetch wrapper backs off main oauth refresh after rate limits', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
      }),
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
    const savedConfig = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(savedConfig.refresh?.mainLastRefreshError).toBeUndefined()
    const savedState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(savedState.main.lastRefreshError.nextRetryAt).toBeGreaterThan(
      Date.now(),
    )
  })

  test('successful re-login clears a live stale main refresh backoff', async () => {
    const now = Date.now()
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        mainAccountId: 'main-account-id',
        quota: {
          enabled: false,
          mainLastQuotaApiError: {
            message: 'stale quota failure',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            retryCount: 1,
          },
        },
        refresh: {
          enabled: true,
          mainLastRefreshError: {
            message: 'stale refresh failure',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            retryCount: 1,
            accountIdentity: 'relogged-main-refresh',
          },
        },
      }),
      {
        access: 'sk-ant-oat01-relogged-main-access',
        refresh: 'relogged-main-refresh',
        expires: now + 60 * 60_000,
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
              refresh_token: 'relogged-main-refresh-new',
              access_token: 'sk-ant-oat01-relogged-main-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-relogged-main-access',
          refresh: 'relogged-main-refresh',
          expires: now + 60 * 60_000,
        }),
      { models: {} },
    )
    const preflight = await readAccountStorage()
    expect(preflight?.refresh?.mainLastRefreshError).toEqual(
      expect.objectContaining({
        accountIdentity: 'relogged-main-refresh',
        nextRetryAt: expect.any(Number),
      }),
    )

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(tokenRefreshCalls).toBe(0)
    const savedState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(savedState.main.lastRefreshError).toBeUndefined()
    const savedConfig = await readAccountStorage()
    expect(savedConfig?.quota?.mainLastQuotaApiError).toBeUndefined()
  })

  test('successful re-login preserves the current account main quota backoff', async () => {
    const now = Date.now()
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        mainAccountId: 'main-account-id',
        quota: {
          enabled: false,
          mainLastQuotaApiError: {
            message: 'current quota failure',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            retryCount: 1,
            accountIdentity: 'main-account-id',
          },
        },
        refresh: {
          enabled: true,
          mainLastRefreshError: {
            message: 'stale refresh failure',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            retryCount: 1,
            accountIdentity: 'relogged-main-refresh',
          },
        },
      }),
      {
        access: 'sk-ant-oat01-relogged-main-access',
        refresh: 'relogged-main-refresh',
        expires: now + 60 * 60_000,
      },
    )
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/v1/messages'))
          return Promise.resolve(new Response('{}', { status: 200 }))
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-relogged-main-access',
          refresh: 'relogged-main-refresh',
          expires: now + 60 * 60_000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(200)
    const savedConfig = await readAccountStorage()
    // The entry surviving is not the property under test — a backoff whose
    // retry time has been zeroed is no longer restricting anything.
    expect(savedConfig?.quota?.mainLastQuotaApiError).toEqual(
      expect.objectContaining({
        accountIdentity: 'main-account-id',
        message: 'current quota failure',
        nextRetryAt: now + 60_000,
      }),
    )
    expect(
      savedConfig?.quota?.mainLastQuotaApiError?.nextRetryAt,
    ).toBeGreaterThan(Date.now())
  })

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
    }) as unknown as typeof fetch

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
    expect(setTimeoutMock).toHaveBeenCalledTimes(1)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 500)
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
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

    expect(
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
            'data: {"content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
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
        body: '{}',
      },
    )

    const text = await response.text()
    expect(text).toContain('"name": "bash"')
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
    // The first plugin's token exchange is held open, so the second plugin's
    // request arrives while that refresh is still in progress. OpenCode's
    // auth store no longer receives refreshed tokens (the pool persists
    // them), so the delayed persistence the legacy test held is now the
    // in-flight exchange itself.
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
    const secondRefreshWait = mock(() => {
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

    const responses = await Promise.all([firstFetch, secondFetch])
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

  test('sticky 401 retry refuses a foreign-provider tombstone before the token endpoint', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
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
            five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt },
            seven_day: { usedPercent: 10, remainingPercent: 90, checkedAt },
          },
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('sk-ant-oat01-live-main-access'),
        },
      }),
    )
    let currentAuth: Record<string, unknown> = {
      type: 'oauth',
      access: 'sk-ant-oat01-live-main-access',
      refresh: 'live-main-refresh',
      expires: checkedAt + 8 * 60 * 60_000,
    }
    const messageAuthorizations: string[] = []
    const tokenEndpointCalls: string[] = []
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const url = extractUrl(input as string | URL | Request)
      if (url === TOKEN_URL) {
        tokenEndpointCalls.push(url)
        return Promise.resolve(new Response('unexpected', { status: 200 }))
      }
      if (url.includes('/v1/messages')) {
        messageAuthorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        currentAuth = {
          ...custodyTombstoneOAuth('openai'),
          access: 'claustrum-tombstone:v1:openai',
          expires: 0,
        }
        return Promise.resolve(new Response('unauthorized', { status: 401 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(currentAuth as never),
      { models: {} },
    )

    await expect(
      result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'tombstone-sticky-401' },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(messageAuthorizations).toEqual([
      'Bearer sk-ant-oat01-live-main-access',
    ])
    expect(tokenEndpointCalls).toEqual([])
    await plugin.dispose?.()
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

    await saveAccounts({
      ...storage,
      quota: { ...storage.quota, failClosedOnUnknownQuota: true },
    })
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

  test('successful fallback-first request advances the every-N counter and refreshes the served fallback', async () => {
    // Regression: the request counter must increment before the fallback-first
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

    // REGRESSION: pre-fix the async callback rewrites activeId to 'main'.
    const after = await getSidebarState()
    expect(after.activeId).toBe('fallback-1')
  })

  test('fetch wrapper retries with fallback when main streaming body reports rate limit', async () => {
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

  test('sticky-balanced retains the assigned account across transient errors and a short 5h reset', async () => {
    const checkedAt = Date.now()
    const shortResetAt = new Date(checkedAt + 14 * 60_000).toISOString()
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
    const authorizations: string[] = []
    let modelRequest = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization = new Headers(init?.headers).get('authorization')
          const abundant =
            authorization === 'Bearer sk-ant-oat01-abundant-access'
          const main = authorization === 'Bearer sk-ant-oat01-main-access'
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: {
                  utilization: abundant ? 100 : 0,
                  resets_at: useLongReset ? longResetAt : shortResetAt,
                },
                seven_day: { utilization: 0 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: main ? 100 : abundant ? 2 : 87,
                    resets_at: new Date(
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
              'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"five-hour"}}\n\n',
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
      13 * 60,
    )
    expect(Number(held.headers.get('retry-after'))).toBeLessThanOrEqual(15 * 60)
    expect((await result.fetch(MESSAGES_URL, request)).status).toBe(429)

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

  test('normalizes a server fallback response even when no session-affinity header is available', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 1,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5',
              input_tokens: 1,
              output_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 1,
              output_tokens: 1,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    let sentBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (!extractUrl(input).includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          sentBody = JSON.parse(String(init?.body))
          return Promise.resolve(new Response(fallbackSse, { status: 200 }))
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
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    const responseText = await response.text()

    expect(sentBody?.fallbacks).toBe('default')
    expect(responseText).not.toContain('"type":"fallback","from"')
    expect(responseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
  })

  test('uses Anthropic server-side fallback for Fable 5.1 and reports transitions', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false } as AccountStorage['quota'],
      }),
    )
    const requestBodies: Array<Record<string, unknown>> = []
    const requestBetas: string[] = []
    let modelRequest = 0
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5-1' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'fallback answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 2,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5-1',
              input_tokens: 100,
              output_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    const restoredSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_restored', model: 'claude-fable-5-1' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'source answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 2,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5-1',
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (!extractUrl(input).includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          requestBodies.push(JSON.parse(String(init?.body)))
          requestBetas.push(
            new Headers(init?.headers).get('anthropic-beta') ?? '',
          )
          modelRequest++
          return Promise.resolve(
            new Response(modelRequest === 1 ? fallbackSse : restoredSse, {
              status: 200,
            }),
          )
        },
      ),
    ) as unknown as typeof fetch

    const latestUserMessageId = 'msg_000000000100AAAAAAAAAAAAAA'
    const latestAssistantMessageId = 'msg_000000000200BBBBBBBBBBBBBB'
    const mockClient = createMockClient([
      {
        info: {
          id: latestUserMessageId,
          role: 'user',
          agent: 'Alfonso - CTO',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'xhigh',
          },
        },
      },
      {
        info: {
          id: latestAssistantMessageId,
          role: 'assistant',
          agent: 'Alfonso - CTO',
          providerID: 'anthropic',
          modelID: 'claude-fable-5-1',
          variant: 'xhigh',
        },
      },
    ])
    const plugin = await getPlugin(mockClient)
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_server_fallback' },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const fallbackResponse = await result.fetch(MESSAGES_URL, request)
    const fallbackResponseText = await fallbackResponse.text()
    expect(fallbackResponseText).toContain('fallback answer')
    expect(fallbackResponseText).not.toContain('"type":"fallback","from"')
    expect(fallbackResponseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]?.fallbacks).toBe('default')
    expect(requestBetas[0]?.split(',')).toContain(SERVER_SIDE_FALLBACK_BETA)
    const switched = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_server_fallback' &&
            recovery.mode === 'server',
        ),
      ),
    )
    expect(switched.fableRecoveries?.[0]).toMatchObject({
      requestedModelId: 'claude-fable-5-1',
      targetModelId: 'claude-opus-5',
      remaining: 0,
    })
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            finish: 'tool-calls',
            time: { completed: Date.now() },
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            finish: 'stop',
            time: { completed: Date.now() },
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_server_fallback',
          status: { type: 'idle' },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_server_fallback' },
        body: expect.objectContaining({
          noReply: true,
          parts: [
            expect.objectContaining({
              text: expect.stringContaining('Anthropic safety fallback'),
            }),
          ],
        }),
      }),
    )

    // Model the real host: the first ignored notice becomes the newest user
    // message. A second notice must have a distinct ordered ID, registered
    // before promptAsync emits its user-message event.
    const firstNotice = mockClient.session.promptAsync.mock.calls[0]?.[0] as {
      body: { messageID: string }
    }
    const originalMessages = await mockClient.session.messages!()
    mockClient.session.messages = mock(async () => ({
      data: [
        ...originalMessages.data,
        { info: { id: firstNotice.body.messageID, role: 'user' } },
      ],
    }))
    const noticeWasTrackedAtDispatch: boolean[] = []
    mockClient.session.promptAsync.mockImplementation(
      async (input: unknown) => {
        const notice = input as {
          path: { id: string }
          body: { messageID: string }
        }
        noticeWasTrackedAtDispatch.push(
          typeof notice.body.messageID === 'string' &&
            plugin.__isDesktopNoticeMessageForTest(
              notice.path.id,
              notice.body.messageID,
            ),
        )
        await plugin.event?.({
          event: {
            type: 'message.updated',
            properties: {
              info: {
                id: notice.body.messageID,
                sessionID: notice.path.id,
                role: 'user',
              },
            },
          },
        })
      },
    )

    const restoredResponse = await result.fetch(MESSAGES_URL, request)
    // OpenCode can publish the assistant-completed event before the wrapped
    // response emits its final fallback outcome. The idle event must flush a notice
    // queued after that completion event without requiring a later session update.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            time: { completed: Date.now() },
          },
        },
      },
    })
    await expect(restoredResponse.text()).resolves.toContain('source answer')
    const restored = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_server_fallback' &&
            recovery.mode === 'fable',
        ),
      ),
    )
    expect(restored.fableRecoveries?.[0]?.requestedModelId).toBe(
      'claude-fable-5-1',
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback' },
      },
    })
    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(1)
        },
      },
    })
    expect(mockClient.session.promptAsync.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: expect.stringContaining('Returning to Fable 5.1'),
            }),
          ],
        }),
      }),
    )

    const secondNotice = mockClient.session.promptAsync.mock.calls[1]?.[0] as {
      body: { messageID: string }
    }
    expect(noticeWasTrackedAtDispatch).toEqual([true])
    expect(secondNotice.body.messageID > firstNotice.body.messageID).toBe(true)
    expect(secondNotice.body.messageID < latestAssistantMessageId).toBe(true)

    // The host history still contains only notice 1. Notice 2's own event must
    // leave the idle lease intact, and local allocation must avoid reusing its
    // ID even before session.messages catches up. No new idle event is sent.
    modelRequest = 0
    const thirdTransition = await result.fetch(MESSAGES_URL, request)
    await thirdTransition.text()
    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(2)
        },
      },
    })
    const thirdNotice = mockClient.session.promptAsync.mock.calls[2]?.[0] as {
      body: { messageID: string }
    }
    expect(thirdNotice.body.messageID > secondNotice.body.messageID).toBe(true)
    expect(thirdNotice.body.messageID < latestAssistantMessageId).toBe(true)
    expect(noticeWasTrackedAtDispatch).toEqual([true, true])

    // A rapid fallback cycle can replace the pending switch notice while its
    // asynchronous prompt-context lookup is still in flight. The stale send
    // must stand down and the active flush must continue with the replacement.
    mockClient.session.promptAsync.mockClear()
    modelRequest = 0
    const immediateMessages = mockClient.session.messages
    let releasePromptContext: (() => void) | undefined
    let messageLookups = 0
    mockClient.session.messages = mock(() => {
      messageLookups++
      if (messageLookups > 1) {
        return immediateMessages?.() ?? Promise.resolve({ data: [] })
      }
      return new Promise<{ data: unknown[] }>((resolve) => {
        releasePromptContext = () => {
          void Promise.resolve(immediateMessages?.()).then((response) =>
            resolve(response ?? { data: [] }),
          )
        }
      })
    })
    const overtakenRequest = {
      ...request,
      headers: { 'x-session-affinity': 'ses_server_fallback_overtaken' },
    }
    const overtakenFallback = await result.fetch(MESSAGES_URL, overtakenRequest)
    await overtakenFallback.text()
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestUserMessageId,
            sessionID: 'ses_server_fallback_overtaken',
            role: 'user',
          },
        },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback_overtaken' },
      },
    })
    for (let attempt = 0; attempt < 100 && !releasePromptContext; attempt++) {
      await Bun.sleep(1)
    }
    expect(releasePromptContext).toBeDefined()

    const overtakenRestoration = await result.fetch(
      MESSAGES_URL,
      overtakenRequest,
    )
    await overtakenRestoration.text()
    releasePromptContext?.()
    await waitForMockCall(mockClient.session.promptAsync)

    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: expect.stringContaining('Returning to Fable 5.1'),
            }),
          ],
        }),
      }),
    )
    // Missing ordering context must retain the notice, never send a host-minted
    // user ID. Once the host exposes a safe boundary, the same notice can drain.
    mockClient.session.promptAsync.mockClear()
    mockClient.session.messages = mock(async () => ({ data: [] }))
    modelRequest = 0
    const unplaced = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_notice_unplaced' },
    })
    await unplaced.text()
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_notice_unplaced' },
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(mockClient.session.messages).toHaveBeenCalled()
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_notice_unplaced' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  test('downgrades a filtered Fable session for ten successful Opus turns and warms Fable after each', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: false },
      }),
    )
    const normalModels: string[] = []
    const warmBodies: Array<Record<string, unknown>> = []
    let firstFable = true
    let releaseFinalWarm: (() => void) | undefined
    const successfulSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
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
                limits: [],
              }),
              { status: 200 },
            ),
          )
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (body.max_tokens === 0) {
          warmBodies.push(body)
          const warmResponse = () =>
            new Response(
              JSON.stringify({ usage: { cache_read_input_tokens: 100 } }),
              { status: 200 },
            )
          if (warmBodies.length === 10) {
            return new Promise<Response>((resolve) => {
              releaseFinalWarm = () => resolve(warmResponse())
            })
          }
          return Promise.resolve(warmResponse())
        }
        normalModels.push(String(body.model))
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successfulSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const latestUserMessageId = 'msg_000000000100AAAAAAAAAAAAAA'
    const latestAssistantMessageId = 'msg_000000000200BBBBBBBBBBBBBB'
    let releaseStaleIdleStatus:
      | ((statuses: Record<string, { type: string }>) => void)
      | undefined
    let noticeStatusChecks = 0
    const mockClient = createMockClient(
      [
        {
          info: {
            id: latestUserMessageId,
            role: 'user',
            agent: 'Alfonso - CTO',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-fable-5',
              variant: 'xhigh',
            },
          },
        },
        {
          info: {
            id: latestAssistantMessageId,
            role: 'assistant',
            agent: 'Alfonso - CTO',
            providerID: 'anthropic',
            modelID: 'claude-fable-5',
            variant: 'xhigh',
          },
        },
      ],
      () => {
        noticeStatusChecks++
        if (noticeStatusChecks === 1) {
          return new Promise<Record<string, { type: string }>>((resolve) => {
            releaseStaleIdleStatus = resolve
          })
        }
        return {}
      },
    )
    const plugin = await getPlugin(mockClient)
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_fable_filter' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'same session input' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    const reader = filtered.body!.getReader()
    let caught: unknown
    try {
      while (!(await reader.read()).done) {}
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('ECONNRESET')
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    const switchedState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'opus',
        ),
      ),
    )
    expect(
      switchedState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.remaining,
    ).toBe(10)

    // The switch notice is deliberately held until the first successful Opus
    // response proves that OpenCode's internal retry has completed.
    const firstOpus = await result.fetch(MESSAGES_URL, request)
    await firstOpus.text()

    // Seed the user-message identity that produced the upcoming idle event.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestUserMessageId,
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })

    // Reproduce the host race from issue #162: an idle probe starts, then a new
    // prompt marks the session busy before the asynchronous status response
    // arrives with its now-stale idle snapshot. The notice must remain queued;
    // otherwise OpenCode can adopt that ignored user message as the active retry
    // parent and dispatch an extra provider request.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    for (let attempt = 0; attempt < 100 && !releaseStaleIdleStatus; attempt++) {
      await Bun.sleep(1)
    }
    expect(releaseStaleIdleStatus).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_fable_filter',
          status: { type: 'busy' },
        },
      },
    })
    releaseStaleIdleStatus?.({})
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    // Also cover the later race window: status was idle, but a new prompt starts
    // while the notification path is resolving message history for placement.
    const immediateMessages = mockClient.session.messages
    let releasePromptContext: (() => void) | undefined
    mockClient.session.messages = mock(
      () =>
        new Promise<{ data: unknown[] }>((resolve) => {
          releasePromptContext = () => {
            void Promise.resolve(immediateMessages?.()).then((response) =>
              resolve(response ?? { data: [] }),
            )
          }
        }),
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    for (let attempt = 0; attempt < 100 && !releasePromptContext; attempt++) {
      await Bun.sleep(1)
    }
    expect(releasePromptContext).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_fable_filter',
          status: { type: 'busy' },
        },
      },
    })
    releasePromptContext?.()
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages

    // OpenCode can publish the new user message before its busy status update.
    // That earlier event must also revoke the idle-delivery lease.
    let releaseUserMessagePromptContext: (() => void) | undefined
    mockClient.session.messages = mock(
      () =>
        new Promise<{ data: unknown[] }>((resolve) => {
          releaseUserMessagePromptContext = () => {
            void Promise.resolve(immediateMessages?.()).then((response) =>
              resolve(response ?? { data: [] }),
            )
          }
        }),
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    for (
      let attempt = 0;
      attempt < 100 && !releaseUserMessagePromptContext;
      attempt++
    ) {
      await Bun.sleep(1)
    }
    expect(releaseUserMessagePromptContext).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_new_user',
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    releaseUserMessagePromptContext?.()
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages

    // A later authoritative idle signal retries the still-queued notice.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_new_user',
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.updated',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_fable_filter' },
        body: expect.objectContaining({
          messageID: expect.any(String),
          noReply: true,
          agent: 'Alfonso - CTO',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5',
          },
          variant: 'xhigh',
          parts: [
            expect.objectContaining({
              type: 'text',
              ignored: true,
              text: expect.stringContaining('Switched to Opus 4.8'),
            }),
          ],
        }),
      }),
    )
    const switchNotificationRequest = mockClient.session.promptAsync.mock
      .calls[0]?.[0] as { body: { messageID?: string } } | undefined
    const switchNotificationMessageId =
      switchNotificationRequest?.body.messageID
    expect(switchNotificationMessageId! > latestUserMessageId).toBe(true)
    expect(switchNotificationMessageId! < latestAssistantMessageId).toBe(true)
    expect(normalModels).toHaveLength(2)

    for (let turn = 1; turn < 10; turn++) {
      const response = await result.fetch(MESSAGES_URL, request)
      await response.text()
    }

    for (let attempt = 0; attempt < 100 && warmBodies.length < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(normalModels).toEqual([
      'claude-fable-5',
      ...Array.from({ length: 10 }, () => 'claude-opus-4-8'),
    ])
    expect(warmBodies).toHaveLength(10)
    for (const warm of warmBodies) {
      expect(warm.model).toBe('claude-fable-5')
      expect(warm.max_tokens).toBe(0)
      expect(warm.stream).toBeUndefined()
      expect(warm.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      })
      expect(warm.messages).toHaveLength(1)
      expect(warm.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              expect.objectContaining({ text: 'same session input' }),
            ]),
          }),
        ]),
      )
    }

    const restoredPromise = result.fetch(MESSAGES_URL, request)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(normalModels).toHaveLength(11)
    expect(releaseFinalWarm).toBeDefined()

    const opus5Request = {
      ...request,
      body: JSON.stringify({
        ...JSON.parse(request.body),
        model: 'claude-opus-5',
      }),
    }
    const opus5ResponsePromise = result.fetch(MESSAGES_URL, opus5Request)
    for (
      let attempt = 0;
      attempt < 1_000 && normalModels.at(-1) !== 'claude-opus-5';
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    const opus5ReachedUpstream = normalModels.at(-1) === 'claude-opus-5'
    if (!opus5ReachedUpstream) releaseFinalWarm?.()
    expect(opus5ReachedUpstream).toBe(true)
    const opus5Response = await opus5ResponsePromise
    await opus5Response.text()
    expect(normalModels).toHaveLength(12)

    const waitingState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'opus' &&
            recovery.remaining === 0,
        ),
      ),
    )
    expect(
      waitingState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.mode,
    ).toBe('opus')

    // Reproduce the host race: OpenCode can publish idle while the final cache
    // warm is still pending, before the restoration notice has been queued.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.updated',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    // The ignored switch notice is itself stored as a user message. Its event
    // must not revoke the real user's idle-delivery lease for a newer notice.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: switchNotificationMessageId,
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)

    releaseFinalWarm?.()
    const restored = await restoredPromise
    await restored.text()
    expect(normalModels.at(-1)).toBe('claude-fable-5')

    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(1)
        },
      },
    })
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(2)
    expect(mockClient.session.promptAsync.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_fable_filter' },
        body: expect.objectContaining({
          messageID: expect.any(String),
          noReply: true,
          parts: [
            expect.objectContaining({
              type: 'text',
              ignored: true,
              text: expect.stringContaining('Returning to Fable 5'),
            }),
          ],
        }),
      }),
    )
    expect(normalModels).toHaveLength(13)

    const restoredState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'fable',
        ),
      ),
    )
    expect(
      restoredState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.remaining,
    ).toBe(0)
  })

  test('server mode — refusal with no server-side handoff downgrades to Opus (wedge regression)', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    let firstFable = true
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
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successSse, { status: 200 }))
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_wedge' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    // First request hits the refusal — onContentFilter fires, stream rejects.
    // The second request must carry the downgraded Opus model.
    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const second = await result.fetch(MESSAGES_URL, request)
    await second.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
  })

  test('server mode — absorbed server-side fallback does NOT activate client-side downgrade', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'safe answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }),
      frame('message_stop', { type: 'message_stop' }),
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
        return Promise.resolve(new Response(fallbackSse, { status: 200 }))
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_no_double' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const first = await result.fetch(MESSAGES_URL, request)
    await first.text()
    const second = await result.fetch(MESSAGES_URL, request)
    await second.text()

    // Both requests stayed on Fable — no client-side downgrade triggered.
    expect(models).toEqual(['claude-fable-5', 'claude-fable-5'])
  })

  test('server mode — downgraded Opus request does not carry server-side fallback opt-in', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    let firstFable = true
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
        bodies.push(body)
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successSse, { status: 200 }))
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_no_optin' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    // First request hits the refusal. After the fix, onContentFilter fires
    // causing the stream to reject with a ContentFilterError.
    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
    // The Opus request must NOT carry the server-side fallback opt-in.
    expect(bodies[1]?.fallbacks).toBeUndefined()
  })

  test('uses the sidebar instead of promptAsync when the matching TUI is connected', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
    )
    resetNotificationsForTest()
    drainNotifications(0, 'ses_tui_fable')
    const refusal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'

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
        return Promise.resolve(new Response(refusal, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
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
      headers: { 'x-session-affinity': 'ses_tui_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    try {
      await response.text()
    } catch {}
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_tui_fable',
          status: { type: 'idle' },
        },
      },
    })

    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    const state = await waitForSidebarState((candidate) =>
      Boolean(
        candidate.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_tui_fable' &&
            recovery.mode === 'opus' &&
            recovery.remaining === 10,
        ),
      ),
    )
    expect(state.fableRecoveries).toHaveLength(1)
  })

  test('warms Fable with the OAuth account that was filtered when Opus routes elsewhere', async () => {
    const now = Date.now()
    await useTempAccountFile(
      createFallbackStorage({
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: false },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          mainQuota: {
            five_hour: { usedPercent: 0, remainingPercent: 100 },
            seven_day: { usedPercent: 0, remainingPercent: 100 },
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
          mainQuotaCheckedAt: now,
          mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'fable-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
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
    )
    const calls: Array<{ model: string; auth: string; warm: boolean }> = []
    let firstFable = true
    const success =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const refusal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'

    globalThis.fetch = mock((input: any, init: any) => {
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
      const body = JSON.parse(String(init?.body)) as {
        model: string
        max_tokens?: number
      }
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      calls.push({ model: body.model, auth, warm: body.max_tokens === 0 })
      if (body.max_tokens === 0) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      if (body.model === 'claude-fable-5' && firstFable) {
        firstFable = false
        return Promise.resolve(new Response(refusal, { status: 200 }))
      }
      return Promise.resolve(new Response(success, { status: 200 }))
    }) as unknown as typeof fetch

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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_account_bound_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 100,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    const filteredReader = filtered.body!.getReader()
    try {
      while (!(await filteredReader.read()).done) {}
    } catch {}

    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()
    for (let attempt = 0; attempt < 100 && calls.length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    expect(calls).toEqual([
      {
        model: 'claude-fable-5',
        auth: 'Bearer sk-ant-oat01-fallback-access',
        warm: false,
      },
      {
        model: 'claude-opus-4-8',
        auth: 'Bearer sk-ant-oat01-main-access',
        warm: false,
      },
      {
        model: 'claude-fable-5',
        auth: 'Bearer sk-ant-oat01-fallback-access',
        warm: true,
      },
    ])
  })

  test('background fallback refresh updates the sidebar without a request', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            quota: {
              // Stale (old checkedAt) → background pass will refresh it.
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
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
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
      }),
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

    // The background pass refreshes the stale fallback and the hook re-writes the
    // sidebar — without any request to the messages endpoint.
    // utilization: 0.42 → usedPercent: 0.42 (stored as-is, not multiplied by 100)
    const state = await waitForSidebarState(
      (candidate) =>
        candidate.fallbacks[0]?.quota?.five_hour?.usedPercent === 0.42,
    )
    expect(state.fallbacks[0]?.id).toBe('fallback-1')
  })

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
        expect(plugin.__quotaManager.getMain(poolMainIdentity())).toBeNull()
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
        if (!migratedPool) throw new Error('This test has no migrated pool')
        const reader = createNativeAccountRuntime({
          paths: migratedPool.paths,
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
                data: Buffer.from('event: message_stop\n\n'),
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

    // Harvested quota is published to the native pool; the legacy state file
    // these tests once read is retired by migration.
    async function waitForState(predicate: (state: any) => boolean) {
      let lastState: unknown
      for (let attempt = 0; attempt < 200; attempt++) {
        // Typed loosely, as the parsed legacy file was: each test asserts the
        // fields it expects to be present.
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
      // Header quota is bound to the main account, never to the access token
      // that happened to carry it (the legacy store's quotaToken).
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
      // Header quota is bound to the main account, never to the access token
      // that happened to carry it (the legacy store's quotaToken).
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
      let relay503Calls = 0
      let directCalls = 0
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          const url = extractUrl(input)
          if (url === 'https://relay.example.test/') {
            relay503Calls += 1
            return Promise.resolve(
              new Response('relay unavailable', { status: 503 }),
            )
          }
          directCalls += 1
          return Promise.resolve(
            new Response('direct', { headers: quotaHeaders }),
          )
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      try {
        const response = await result.fetch(MESSAGES_URL, {
          ...EMPTY_POST,
          headers: { 'x-session-affinity': 'quota-relay-direct-fallback' },
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
      if (!migratedPool) throw new Error('Expected migrated pool')
      const reader = createNativeAccountRuntime({
        paths: migratedPool.paths,
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
        if (!migratedPool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: migratedPool.paths,
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
        if (!migratedPool) throw new Error('Expected migrated pool')
        const reader = createNativeAccountRuntime({
          paths: migratedPool.paths,
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
      let usageCalls = 0
      globalThis.fetch = mock(
        withNativeAdmission((input: string | URL | Request) => {
          if (extractUrl(input).includes('/api/oauth/usage')) usageCalls++
          return Promise.resolve(new Response('ok', { headers: quotaHeaders }))
        }),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForSidebarState(
        (value) => value.main.quota?.five_hour?.usedPercent === 78,
      )

      expect(state.main.quota?.five_hour?.usedPercent).toBe(78)
      expect(state.lastUpdated).toBeGreaterThan(0)
      expect(usageCalls).toBe(0)
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

describe('claude-start integration', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
    resetCache1hState()
    resetDumpState()
    setLogLevel('info')
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
      }),
    )
  })

  afterEach(async () => {
    __setLogTestSink(null)
    globalThis.fetch = originalFetch
    pluginRuntimeOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    tempConfigDir = undefined
  })

  test('claude-start request shapes only its correlated OAuth turn and emits diagnostics', async () => {
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        sent.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        })
        return Promise.resolve(
          new Response(
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: 'provider-start',
                model: 'claude-opus-4-8',
                usage: {
                  input_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 1,
                  cache_creation: {
                    ephemeral_5m_input_tokens: 0,
                    ephemeral_1h_input_tokens: 1,
                  },
                },
                diagnostics: { cache_miss_reason: null },
              },
            })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
            { status: 200 },
          ),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const client = createMockClient()
    const plugin = await getPlugin(client)
    // Diagnostics records emit at debug level; enable it after plugin
    // load so boot-time level application cannot reset it.
    setLogLevel('debug')
    const headers: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-start' },
      {
        message: { id: 'msg-start' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin['chat.headers'](
      { sessionID: 'ses-start', message: { id: 'msg-start' } },
      { headers },
    )
    expect(headers).toEqual({ [LANE_START_REQUEST_HEADER]: '1' })

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
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-start', ...headers },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          max_tokens: 99,
          thinking: { type: 'enabled', budget_tokens: 10 },
          messages: [{ role: 'user', content: 'start' }],
        }),
      })
    ).text()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({ max_tokens: 1, stream: true })
    expect(sent[0]?.body.thinking).toBeUndefined()
    expect(sent[0]?.headers.has(LANE_START_REQUEST_HEADER)).toBe(false)
    const record = records.find(
      (entry) =>
        entry.channel === 'cache-diagnostics' &&
        entry.message.includes('provider-start'),
    )
    expect(record).toBeDefined()
    expect(
      JSON.parse(record!.message.replace('MC-CACHE-DIAG ', '')),
    ).toMatchObject({
      v: 2,
      source: 'start',
      synthetic: true,
      account_id: 'main',
      session_id: 'ses-start',
    })

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'ses-start',
      }),
    )
    const latest = (
      client.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls.at(-1)?.[0]
    expect(latest?.body.parts[0]?.text).toContain('ses-start')
    setLogLevel('info')
  })

  test('claude-start concurrency does not shape an interleaved real turn', async () => {
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        sent.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        })
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const startHeaders: Record<string, string> = {}
    const realHeaders: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-race' },
      {
        message: { id: 'msg-start' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin['chat.headers'](
      { sessionID: 'ses-race', message: { id: 'msg-start' } },
      { headers: startHeaders },
    )
    await plugin['chat.headers'](
      { sessionID: 'ses-race', message: { id: 'msg-real' } },
      { headers: realHeaders },
    )
    expect(realHeaders).toEqual({})

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
    const request = (headers: Record<string, string>, maxTokens: number) =>
      result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-race', ...headers },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          max_tokens: maxTokens,
          thinking: { type: 'enabled', budget_tokens: 10 },
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    await Promise.all([request(startHeaders, 99), request(realHeaders, 77)])

    expect(sent.map((entry) => entry.body.max_tokens).sort()).toEqual([1, 77])
    expect(
      sent.find((entry) => entry.body.max_tokens === 77)?.body.thinking,
    ).toEqual({
      type: 'enabled',
      budget_tokens: 10,
    })
    expect(
      sent.every((entry) => !entry.headers.has(LANE_START_REQUEST_HEADER)),
    ).toBe(true)
  })

  test('claude-start tags direct dumps', async () => {
    const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-start-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
          ),
        ),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const headers: Record<string, string> = {}
      await plugin['chat.message'](
        { sessionID: 'ses-start-dump' },
        {
          message: { id: 'msg-start-dump' },
          parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
        },
      )
      await plugin['chat.headers'](
        { sessionID: 'ses-start-dump', message: { id: 'msg-start-dump' } },
        { headers },
      )
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
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-start-dump', ...headers },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'start' }],
        }),
      })
      expect(
        (await readdir(dumpDir)).some((file) => file.includes('-start-')),
      ).toBe(true)
    } finally {
      if (previousDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('claude-start keeps a fallback-first API-key send ordinary', async () => {
    const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-api-start-dump-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'api-start',
              type: 'api',
              apiKey: 'api-start-key',
              baseURL: 'https://api.example.test',
              authHeader: 'x-api-key',
            },
          ],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      const sent: Array<{ body: Record<string, unknown>; headers: Headers }> =
        []
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          sent.push({ body: JSON.parse(String(init?.body)), headers })
          return Promise.resolve(
            new Response('{}', {
              status: 200,
              headers:
                headers.get('authorization') ===
                'Bearer sk-ant-oat01-main-access'
                  ? {
                      'anthropic-ratelimit-unified-representative-claim':
                        'five_hour',
                      'anthropic-ratelimit-unified-5h-utilization': '1',
                      'anthropic-ratelimit-unified-5h-reset': '1784246400',
                      'anthropic-ratelimit-unified-7d-utilization': '0.4',
                      'anthropic-ratelimit-unified-7d-reset': '1784628000',
                    }
                  : undefined,
            }),
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
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const body = (maxTokens: number) =>
        JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          max_tokens: maxTokens,
          thinking: { type: 'enabled', budget_tokens: 10 },
          messages: [{ role: 'user', content: 'start' }],
        })
      await result.fetch(MESSAGES_URL, { method: 'POST', body: body(50) })
      const headers: Record<string, string> = {}
      await plugin['chat.message'](
        { sessionID: 'ses-api-start' },
        {
          message: { id: 'msg-api-start' },
          parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
        },
      )
      await plugin['chat.headers'](
        { sessionID: 'ses-api-start', message: { id: 'msg-api-start' } },
        { headers },
      )
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-api-start', ...headers },
        body: body(99),
      })

      const apiSend = sent.find(
        (entry) => entry.headers.get('x-api-key') === 'api-start-key',
      )
      expect(apiSend?.body).toMatchObject({ max_tokens: 99 })
      expect(apiSend?.body.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 10,
      })
      expect(apiSend?.headers.has(LANE_START_REQUEST_HEADER)).toBe(false)
      const metadata = await Promise.all(
        (await readdir(dumpDir))
          .filter((file) => file.endsWith('.meta.json'))
          .map(
            async (file) =>
              JSON.parse(await readFile(join(dumpDir, file), 'utf8')) as {
                tag?: string
              },
          ),
      )
      expect(metadata.some((entry) => entry.tag === 'start')).toBe(false)
    } finally {
      if (previousDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('claude-start shapes the OAuth fallback after an API-key failure', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'api-fails',
              type: 'api',
              apiKey: 'api-fails-key',
              baseURL: 'https://api.example.test',
              authHeader: 'x-api-key',
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
          quota: {
            enabled: false,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 40,
                remainingPercent: 60,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        }),
      ),
    )
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        sent.push({ body, headers })
        if (headers.get('x-api-key') === 'api-fails-key') {
          return Promise.resolve(new Response('{}', { status: 429 }))
        }
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers:
              headers.get('authorization') === 'Bearer sk-ant-oat01-main-access'
                ? {
                    'anthropic-ratelimit-unified-representative-claim':
                      'five_hour',
                    'anthropic-ratelimit-unified-5h-utilization': '1',
                    'anthropic-ratelimit-unified-5h-reset': '1784246400',
                    'anthropic-ratelimit-unified-7d-utilization': '0.4',
                    'anthropic-ratelimit-unified-7d-reset': '1784628000',
                  }
                : undefined,
          }),
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
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      max_tokens: 99,
      thinking: { type: 'enabled', budget_tokens: 10 },
      messages: [{ role: 'user', content: 'start' }],
    })
    const headers: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-api-then-oauth' },
      {
        message: { id: 'msg-api-then-oauth' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin['chat.headers'](
      {
        sessionID: 'ses-api-then-oauth',
        message: { id: 'msg-api-then-oauth' },
      },
      { headers },
    )
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-api-then-oauth', ...headers },
      body,
    })

    const apiSend = sent.find(
      (entry) => entry.headers.get('x-api-key') === 'api-fails-key',
    )
    const oauthSend = sent.find(
      (entry) =>
        entry.headers.get('authorization') ===
        'Bearer sk-ant-oat01-fallback-access',
    )
    expect(apiSend?.body).toMatchObject({ max_tokens: 99 })
    expect(apiSend?.body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 10,
    })
    expect(oauthSend?.body).toMatchObject({ max_tokens: 1, stream: true })
    expect(oauthSend?.body.thinking).toBeUndefined()
  })

  test('claude-start clears the one-shot header before non-OAuth passthrough and session reuse', async () => {
    const seenHeaders: Headers[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const headers: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-deleted' },
      {
        message: { id: 'reused-message' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'ses-deleted' },
      },
    })
    await plugin['chat.headers'](
      { sessionID: 'ses-deleted', message: { id: 'reused-message' } },
      { headers },
    )
    expect(headers).toEqual({})

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
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { [LANE_START_REQUEST_HEADER]: '1' },
      body: JSON.stringify({ max_tokens: 99, thinking: { type: 'enabled' } }),
    })
    expect(seenHeaders[0]?.has(LANE_START_REQUEST_HEADER)).toBe(false)
  })
})

describe('cache diagnostics', () => {
  const originalFetch = globalThis.fetch
  const originalDateNow = Date.now

  const message = (
    id: string,
    diagnostics: unknown = { cache_miss_reason: null },
  ) => ({
    id,
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 101,
      cache_read_input_tokens: 75,
      cache_creation_input_tokens: 26,
      cache_creation: {
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 6,
      },
    },
    diagnostics,
  })

  const sseResponse = (data: Record<string, unknown>, status = 200) =>
    new Response(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: data })}\n\n` +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status },
    )

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100_000,
    })

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
    resetCache1hState()
    resetDumpState()
    setLogLevel('info')
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    )
  })

  afterEach(async () => {
    __setLogTestSink(null)
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    pluginRuntimeOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    tempConfigDir = undefined
  })

  test('cache diagnostics binds the provider predecessor at request time', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    const delayedReleases = new Map<string, () => void>()
    const delayedResponse = (providerId: string) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          return new Promise<void>((resolve) => {
            delayedReleases.set(providerId, () => {
              const payload = message(providerId)
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: payload })}\n\n` +
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ),
              )
              controller.close()
              resolve()
            })
          })
        },
      })
      return new Response(body, { status: 200 })
    }
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        const responsePlan = [
          ['ses-diag-A', 'provider-A'],
          ['ses-diag-B', 'provider-B'],
          ['ses-diag-A', 'provider-A-after'],
          ['ses-diag-B', 'provider-B-after'],
        ] as const
        const response = responsePlan[sentBodies.length - 1]
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(
          sentBodies.length <= 2
            ? sseResponse(message(response[1]))
            : delayedResponse(response[1]),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin(
      createMockClient([
        { info: { id: 'msg_opencode_decoy', role: 'assistant' } },
      ]),
    )
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = (sessionId: string) => ({
      method: 'POST',
      headers: { 'x-session-affinity': sessionId },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    await (await result.fetch(MESSAGES_URL, request('ses-diag-A'))).text()
    await (await result.fetch(MESSAGES_URL, request('ses-diag-B'))).text()
    const delayedA = await result.fetch(MESSAGES_URL, request('ses-diag-A'))
    const delayedB = await result.fetch(MESSAGES_URL, request('ses-diag-B'))
    delayedReleases.get('provider-A-after')?.()
    await delayedA.text()
    delayedReleases.get('provider-B-after')?.()
    await delayedB.text()

    expect(sentBodies.map((body) => body.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
      { previous_message_id: 'provider-A' },
      { previous_message_id: 'provider-B' },
    ])
    const lines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      )
      .map((record) => JSON.parse(record.message.replace('MC-CACHE-DIAG ', '')))
    expect(lines).toHaveLength(4)
    expect(
      lines.find((line) => line.message_id === 'provider-A-after'),
    ).toMatchObject({
      previous_message_id: 'provider-A',
      ttl_sent: null,
      cache_read: 75,
      cache_creation: 26,
      input_tokens: 101,
      ephemeral_5m_tokens: 20,
      ephemeral_1h_tokens: 6,
      session_id: 'ses-diag-A',
      is_subagent: false,
      v: 2,
      source: 'turn',
      synthetic: false,
      account_id: 'main',
      betas_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    expect(
      lines.find((line) => line.message_id === 'provider-B-after'),
    ).toMatchObject({
      previous_message_id: 'provider-B',
      session_id: 'ses-diag-B',
    })
    setLogLevel('info')
  })

  test('cache diagnostics isolates missing affinity and strips the parent header', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const sentHeaders: Headers[] = []
    const records: LogTestRecord[] = []
    let requestNumber = 0
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        sentHeaders.push(new Headers(init.headers))
        requestNumber++
        return Promise.resolve(
          sseResponse(message(`provider-${requestNumber}`)),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-parent-session-id': 'parent-1' },
        body,
      })
    ).text()
    await (await result.fetch(MESSAGES_URL, { method: 'POST', body })).text()

    expect(sentBodies.map((entry) => entry.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
    ])
    expect(sentHeaders[0]?.has('x-parent-session-id')).toBe(false)
    const lines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      )
      .map((record) => JSON.parse(record.message.replace('MC-CACHE-DIAG ', '')))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      session_id: 'session-unknown',
      is_subagent: true,
    })
    expect(lines[1]).toMatchObject({
      session_id: 'session-unknown',
      is_subagent: false,
    })
    setLogLevel('info')
  })

  test('cache diagnostics emits the opt-in beta for normal and structured OAuth requests', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const betaHeaders: string[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        betaHeaders.push(new Headers(init.headers).get('anthropic-beta') ?? '')
        return Promise.resolve(
          sseResponse(message(`provider-${sentBodies.length}`)),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, tempConfigDir)
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    expect(
      (
        await applyMenuAction(plugin, 'session-cache-diagnostics', {
          sectionId: 'Diagnostics',
          actionId: 'logging-level',
          values: { level: 'debug' },
        })
      ).ok,
    ).toBe(true)
    for (const output_config of [
      undefined,
      { format: { type: 'json_schema' } },
    ]) {
      await (
        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
            ...(output_config ? { output_config } : {}),
          }),
        })
      ).text()
    }

    expect(sentBodies.map((body) => body.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
    ])
    expect(
      betaHeaders.every((beta) => beta.includes('cache-diagnosis-2026-04-07')),
    ).toBe(true)
    const betaLines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG-BETAS '),
      )
      .map((record) =>
        JSON.parse(record.message.replace('MC-CACHE-DIAG-BETAS ', '')),
      )
    expect(betaLines).toHaveLength(2)
    expect(new Set(betaLines.map((line) => line.hash)).size).toBe(2)
    expect(
      records
        .filter(
          (record) =>
            record.channel === 'cache-diagnostics' &&
            record.message.startsWith('MC-CACHE-DIAG'),
        )
        .map((record) => record.level),
    ).toEqual(['debug', 'debug', 'debug', 'debug'])
    setLogLevel('info')
  })

  test('cache diagnostics observes non-streaming envelopes and carries their provider id forward', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        const id =
          sentBodies.length === 1 ? 'provider-json-A' : 'provider-json-B'
        return Promise.resolve(
          new Response(JSON.stringify(message(id)), { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    await (await result.fetch(MESSAGES_URL, request)).text()

    expect(sentBodies[1]?.diagnostics).toEqual({
      previous_message_id: 'provider-json-A',
    })
    expect(
      records.filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      ),
    ).toHaveLength(2)
    setLogLevel('info')
  })

  test('cache diagnostics records cachekeep prewarms and carries their provider id forward', async () => {
    let now = 1_000
    const intervals: Array<{ callback: () => unknown; ms: number }> = []
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    let prewarmStartedFlag = false
    let resolvePrewarmStarted: (() => void) | undefined
    const prewarmStarted = new Promise<void>((resolve) => {
      resolvePrewarmStarted = () => {
        prewarmStartedFlag = true
        resolve()
      }
    })
    Date.now = mock(() => now) as unknown as typeof Date.now
    pluginRuntimeOverrides = {
      setInterval: mock((callback: () => unknown, ms: number) => {
        intervals.push({ callback, ms })
        return { unref() {} } as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true, subagents: true },
      }),
    )
    let normalRequests = 0
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        sentBodies.push(body)
        if (body.max_tokens === 0) {
          resolvePrewarmStarted?.()
          return Promise.resolve(
            new Response(JSON.stringify(message('provider-warm-B')), {
              status: 200,
            }),
          )
        }
        normalRequests++
        return Promise.resolve(
          sseResponse(
            message(
              normalRequests === 1 ? 'provider-real-A' : 'provider-real-C',
            ),
          ),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-cachekeep' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 55 * 60_000
    const cacheKeepTick = intervals.at(-1)
    if (!cacheKeepTick) throw new Error('missing cachekeep interval')
    cacheKeepTick.callback()
    await Bun.sleep(20)
    await prewarmStarted
    expect(prewarmStartedFlag).toBe(true)
    for (
      let attempt = 0;
      attempt < 50 &&
      !records.some(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.includes('provider-warm-B'),
      );
      attempt++
    ) {
      await Bun.sleep(10)
    }
    await (await result.fetch(MESSAGES_URL, request)).text()

    const prewarmBody = sentBodies.find((body) => body.max_tokens === 0)
    expect(prewarmBody?.diagnostics).toEqual({
      previous_message_id: 'provider-real-A',
    })
    expect(sentBodies.at(-1)?.diagnostics).toEqual({
      previous_message_id: 'provider-warm-B',
    })
    const prewarmRecord = records.find(
      (record) =>
        record.channel === 'cache-diagnostics' &&
        record.message.includes('provider-warm-B'),
    )
    expect(prewarmRecord).toBeDefined()
    expect(
      JSON.parse(prewarmRecord!.message.replace('MC-CACHE-DIAG ', '')),
    ).toMatchObject({
      is_subagent: false,
      ttl_sent: '1h',
      previous_message_id: 'provider-real-A',
      source: 'prewarm_cachekeep',
      synthetic: true,
      account_id: 'main',
      betas_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    setLogLevel('info')
  })

  test('cache diagnostics logs a short-gap previous-message canary but not unavailable', async () => {
    const records: LogTestRecord[] = []
    let now = 1_000
    Date.now = mock(() => now) as unknown as typeof Date.now
    const responses = [
      message('provider-canary-A'),
      message('provider-canary-B', {
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
      message('provider-canary-C', {
        cache_miss_reason: { type: 'unavailable' },
      }),
      message('provider-canary-D', {
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
    ]
    globalThis.fetch = mock(
      withNativeAdmission(() => {
        const response = responses.shift()
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(sseResponse(response))
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-canary' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 299_999
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 300_000
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 300_000
    await (await result.fetch(MESSAGES_URL, request)).text()

    const warnings = records.filter(
      (record) =>
        record.level === 'warn' && record.channel === 'cache-diagnostics',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload).toMatchObject({
      message_id: 'provider-canary-B',
      previous_message_id: 'provider-canary-A',
    })
  })

  test('cache diagnostics stays disabled on API-key fallback while preserving its response artifact', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'cache-diagnostics-api-dump-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            dump: { enabled: true },
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
                type: 'api',
                apiKey: 'kie-key',
                baseURL: 'https://api.kie.ai/claude',
                authHeader: 'authorization-bearer',
              },
            ],
          }),
        ),
      )
      const records: LogTestRecord[] = []
      let sentBody: Record<string, unknown> | undefined
      let sentBeta = ''
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            expect(extractUrl(input)).toBe(
              'https://api.kie.ai/claude/v1/messages?beta=true',
            )
            expect(new Headers(init?.headers).get('authorization')).toBe(
              'Bearer kie-key',
            )
            sentBody = JSON.parse(String(init?.body))
            sentBeta = new Headers(init?.headers).get('anthropic-beta') ?? ''
            return Promise.resolve(sseResponse(message('provider-api')))
          },
        ),
      ) as unknown as typeof fetch
      __setLogTestSink((record) => records.push(record))

      expect((await readAccountStorage())?.dump?.enabled).toBe(true)
      const plugin = await getPlugin()
      expect(isDumpEnabled()).toBe(true)
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-api' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(response.status).toBe(200)
      await response.text()

      expect(sentBody).toBeDefined()
      expect(isDumpEnabled()).toBe(true)
      expect(getDumpDirectory()).toBe(dumpDir)
      expect(sentBody?.diagnostics).toBeUndefined()
      expect(sentBeta).not.toContain('cache-diagnosis-2026-04-07')
      expect(
        records.filter((record) => record.channel === 'cache-diagnostics'),
      ).toHaveLength(0)
      for (let attempt = 0; attempt < 50; attempt++) {
        if (
          (await readdir(dumpDir)).some((file) =>
            file.endsWith('.response.json'),
          )
        )
          break
        await Bun.sleep(10)
      }
      const responseFile = (await readdir(dumpDir)).find((file) =>
        file.endsWith('.response.json'),
      )
      expect(responseFile).toBeString()
      expect(
        JSON.parse(await readFile(join(dumpDir, responseFile!), 'utf8')),
      ).toMatchObject({
        status: 200,
        message_id: 'provider-api',
      })
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('cache diagnostics writes sanitized response artifacts for valid and malformed direct responses', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(
      join(tmpdir(), 'cache-diagnostics-dump-test-'),
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      const responses = [
        sseResponse({
          ...message('provider-dump'),
          content: [{ text: 'secret' }],
        }),
        new Response('not an envelope', { status: 503 }),
      ]
      globalThis.fetch = mock(
        withNativeAdmission(() => {
          const response = responses.shift()
          if (!response) throw new Error('unexpected request')
          return Promise.resolve(response)
        }),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      const request = {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-dump' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }
      await (await result.fetch(MESSAGES_URL, request)).text()
      await (await result.fetch(MESSAGES_URL, request)).text()

      let responseFiles: string[] = []
      for (let attempt = 0; attempt < 50; attempt++) {
        responseFiles = (await readdir(dumpDir)).filter((file) =>
          file.endsWith('.response.json'),
        )
        if (responseFiles.length === 2) break
        await Bun.sleep(10)
      }
      expect(responseFiles).toHaveLength(2)
      const artifacts = await Promise.all(
        responseFiles.map(async (file) =>
          JSON.parse(await readFile(join(dumpDir, file), 'utf8')),
        ),
      )
      expect(artifacts).toContainEqual(
        expect.objectContaining({
          status: 200,
          message_id: 'provider-dump',
          stream_complete: false,
        }),
      )
      expect(artifacts).toContainEqual({ status: 503, stream_complete: false })
      expect(JSON.stringify(artifacts)).not.toContain('secret')
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })
})

describe('killswitch fetch gate', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    // Prevent this plugin instance's background intervals from leaking into
    // later tests without mutating process-global timers used by other files.
    pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    pluginRuntimeOverrides = {}
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  })

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100000,
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
    await useTempAccountFile(
      createFallbackStorage({
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
      }),
    )

    let servedAuth: string | undefined
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization =
            new Headers(init?.headers).get('authorization') ?? ''
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
        return Promise.resolve(new Response('message-ok', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(servedAuth).toContain('sk-ant-oat01-main-access')
    expect(servedAuth).not.toContain('sk-ant-oat01-fallback-access')
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

// -- /claude-prime: direct OAuth sender + quota refresh + accounting ------

describe('claude-prime direct request', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('main prime fires a direct messages request with the documented body shape', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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
    const mgr = (
      plugin as unknown as {
        __primeManager?: { tick: () => Promise<void> }
      }
    ).__primeManager
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
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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
    )

    let observedAuth: string | undefined
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/messages')) {
          const headers = new Headers(init?.headers ?? {})
          observedAuth = headers.get('authorization') ?? undefined
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
    const mgr = (
      plugin as unknown as {
        __primeManager?: { tick: () => Promise<void> }
      }
    ).__primeManager
    await mgr!.tick()

    expect(observedAuth).toBeDefined()
    expect(observedAuth).toContain('sk-ant-oat01-main-access')
  })

  test('main host credential replacement keeps the stable lineage in the same reset window', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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
    await (
      firstPlugin as unknown as {
        __primeManager: { tick: () => Promise<void> }
      }
    ).__primeManager.tick()
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
    await (
      secondPlugin as unknown as {
        __primeManager: { tick: () => Promise<void> }
      }
    ).__primeManager.tick()

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
    const manager = (
      plugin as unknown as { __primeManager: { tick(): Promise<void> } }
    ).__primeManager
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
    // Marker dir is shared across tests; sweep any leftover marker for
    // this reset epoch so a prior suite's fire doesn't suppress the
    // claim and the fresh-check is forced through.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
    await useTempAccountFile(
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
    const mgr = (
      plugin as unknown as {
        __primeManager?: { tick: () => Promise<void> }
      }
    ).__primeManager
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
    const mgr = (
      plugin as unknown as {
        __primeManager?: { tick: () => Promise<void> }
      }
    ).__primeManager

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
    const mgr = (
      plugin as unknown as {
        __primeManager?: { tick: () => Promise<void> }
      }
    ).__primeManager
    await mgr!.tick()
    await mgr!.tick()

    // Two ticks in the same reset cycle: marker claimed → second tick skips
    expect(messageCalls).toBe(1)

    // No counter incremented (the main account records no prime usage)
    const raw = await readNativeRuntimeState()
    expect(raw.main?.prime).toBeUndefined()
  })

  test('successful send increments main prime counters', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
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
    const mgr = (
      plugin as unknown as {
        __primeManager?: { tick: () => Promise<void> }
      }
    ).__primeManager
    await mgr!.tick()

    const raw = await readNativeRuntimeState()
    expect(raw.main?.prime).toEqual({
      count: 1,
      inputTokens: 20,
      outputTokens: 1,
      since: expect.any(Number),
    })
  })

  test('main prime refreshes a missing access token before firing (M2)', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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
    const mgr = (
      plugin as unknown as { __primeManager?: { tick: () => Promise<void> } }
    ).__primeManager
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
    const mgr1 = (plugin1 as any).__primeManager
    const firstLoadStorage = mgr1.options.loadStorage
    expect(mgr1).toBeDefined()
    expect(mgr1.isStopped?.()).toBeFalsy()
    const plugin2 = await getPlugin()
    const mgr2 = (plugin2 as any).__primeManager
    expect(mgr2).toBeDefined()
    expect(mgr2).toBe(mgr1)
    expect(mgr2.options.loadStorage).not.toBe(firstLoadStorage)
    expect(mgr1.isStopped()).toBe(false)
  })

  test('plugin instances with different storage paths own independent prime managers', async () => {
    const fixture = createFallbackStorage({ prime: { enabled: true } })
    await useTempAccountFile(fixture)
    const plugin1 = await getPlugin(undefined, '/project/one')
    const mgr1 = (plugin1 as any).__primeManager

    await useTempAccountFile(fixture)
    const plugin2 = await getPlugin(undefined, '/project/two')
    const mgr2 = (plugin2 as any).__primeManager

    expect(mgr2).not.toBe(mgr1)
    expect(mgr1.isStopped()).toBe(false)
    expect(mgr2.isStopped()).toBe(false)
  })
})

describe('claude-prime sidebar on toggle', () => {
  let sidebarStateFile: string | undefined

  beforeEach(async () => {
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })
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
    const plugin = await getPlugin(undefined, tempConfigDir)
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
    const plugin = await getPlugin(undefined, tempConfigDir)
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
    // Prime a baseline sidebar write by issuing `/claude-prime on` (the
    // mutation path publishes the sidebar section per M7).
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
  // R1: only snapshots stamped during the current refresh call are fresh.
  // R2: refreshPrimeFallbackQuota must make exactly ONE usage-API call
  // (the refreshAccountQuota path), not two. The second quotaManager.
  // refreshFallback call is redundant — its result is ignored.

  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('R1: the manager skips a quota result classified stale', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

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
    const mgr = (plugin as any).__primeManager
    mgr.options.refreshQuota = async () => ({
      quota: cachedQuota,
      fresh: false,
    })
    await mgr.tick()

    expect(primeCalls).toHaveLength(0)
  })

  test('R1: the manager fires after a quota result classified fresh', async () => {
    const now = Date.now() - 60_000
    const past = now - 120_000
    await useTempAccountFile(
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
    )

    const primeCalls: any[] = []
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
    const mgr = (plugin as any).__primeManager
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
    // Each test runs from a fresh temp dir but the prime marker dir is
    // shared across processes. Sweep any leftover marker for this reset
    // epoch so a prior suite's fire doesn't suppress the R2 claim AND
    // doesn't trigger the manager's `refreshPrimeFallbackQuota` twice
    // (once for the cached account, once for the due account).
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
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
    const mgr = (plugin as any).__primeManager
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
    const quotaManager = (plugin as any).__quotaManager
    quotaManager.setFallback(
      'work-alt',
      {
        quota: cachedQuota,
        refreshAfter: now,
        checkedAt: now + 60_000,
      },
      undefined,
    )
    await expect(
      quotaManager.refreshFallback(
        'work-alt',
        'sk-ant-oat01-fb-access',
        undefined,
      ),
    ).rejects.toThrow('429')

    const mgr = (plugin as any).__primeManager
    await mgr.tick()

    expect(primeCalls).toBe(0)
  })
})

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
    paths: migratedPool!.paths,
    host: 'opencode',
  })
  const manager = (plugin as unknown as { __primeManager: PrimeManager })
    .__primeManager
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
  // R3: on a fresh-check-ok-but-fire-time-token-refresh-fails path,
  // both the adapter-side `prime fire failed` warn (index.ts main
  // catch) and the manager-side warn emit the same message. Only the
  // manager should log — the adapter must surface the error to the
  // manager as a non-ok result and not log itself.

  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('R3: a fire-time main token refresh failure produces exactly one warn·prime·prime token refresh failed record (distinct from the generic fire-failed event)', async () => {
    const { records, refreshRequests } = await primeWarningsAfterQuotaCheck(
      false,
      async (runtime) => {
        await runtime.loginOAuth({
          routeId: 'main',
          replace: true,
          accountIdentity: poolMainIdentity(),
          credential: {
            access: '',
            refresh: 'main-refresh',
            expires: Date.now() - 1_000,
          },
        })
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
        const identity = (await runtime.read()).accounts.find(
          (account) => account.id === 'work-alt',
        )?.accountIdentity
        expect(identity).toBeDefined()
        await runtime.loginOAuth({
          routeId: 'work-alt',
          replace: true,
          accountIdentity: identity,
          credential: {
            access: '',
            refresh: 'fb-refresh',
            expires: Date.now() - 1_000,
          },
        })
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
