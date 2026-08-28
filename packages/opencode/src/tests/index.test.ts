import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
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
import {
  __setLogTestSink,
  type AccountStorage,
  acquireRefreshFileLock,
  buildPrimeRequestBody,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  extractBillingHeaderCCH,
  getAccountStatePath,
  getClaudeCodeIdentity,
  getOrCreatePrimeAuthLineageId,
  hashRefreshToken,
  isOAuthAccount,
  type LogTestRecord,
  loadAccounts,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  PROFILE_TTL_MS,
  resetCache1hState,
  resetClaudeCodeIdentityCachesForTest,
  resetDumpState,
  resetFastModeState,
  saveAccountState,
  saveAccounts,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import { LANE_START_REQUEST_HEADER, LANE_START_TEXT } from '../lane-start'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol'
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

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

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

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = { method: 'POST', body: '{}' } as const
let tempConfigDir: string | undefined

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
        access: 'fallback-access',
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
  await useTempAccountFile(storage)
  await saveAccountState(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE, {
    mainQuota: true,
  })
  globalThis.fetch = mock((input: any) => {
    const url = extractUrl(input)
    if (url.includes('/api/oauth/usage'))
      return Promise.reject(new Error('quota source unavailable'))
    return Promise.resolve(new Response('{}', { status: 200 }))
  }) as unknown as typeof fetch
  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 100000,
      }),
    { models: {} },
  )
  const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
  expect(response.status).toBe(429)
}

async function useTempAccountFile(storage: AccountStorage) {
  if (tempConfigDir) {
    await drainSidebarWrites()
    await rm(tempConfigDir, { recursive: true, force: true })
  }
  tempConfigDir = await mkdtemp(join(tmpdir(), 'anthropic-plugin-test-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    tempConfigDir,
    'anthropic-auth.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    tempConfigDir,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    tempConfigDir,
    'cachekeep-registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    tempConfigDir,
    'quota-header-feed',
  )
  await saveAccounts(storage)
  if (storage.main?.profile) {
    await saveAccountState(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE, {
      mainProfile: true,
    })
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

async function waitForAccountStorage(
  predicate: (storage: Awaited<ReturnType<typeof loadAccounts>>) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const storage = await loadAccounts()
    if (predicate(storage)) return storage
    await Bun.sleep(10)
  }
  const storage = await loadAccounts()
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
 * with an already-expired OAuth token.
 */
async function setupExpiredTokenLoader() {
  const setTimeoutMock = mock((handler: () => unknown) => {
    handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  const mockClient = createMockClient()
  const plugin = await getPlugin(mockClient, undefined, {
    setTimeout: setTimeoutMock,
  })
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth',
        access: 'expired-token',
        refresh: 'old-refresh',
        expires: Date.now() - 1000,
      }),
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

type PluginTimerOverrides = Partial<{
  setTimeout: typeof globalThis.setTimeout
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
}>

let pluginTimerOverrides: PluginTimerOverrides = {}

beforeEach(() => {
  resetClaudeCodeIdentityCachesForTest()
})

async function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  timerOverrides: PluginTimerOverrides = pluginTimerOverrides,
) {
  return (await (
    AnthropicAuthPlugin as unknown as (
      ctx: Parameters<typeof AnthropicAuthPlugin>[0],
      timers?: PluginTimerOverrides,
    ) => ReturnType<typeof AnthropicAuthPlugin>
  )(
    {
      // @ts-expect-error: minimal mock for testing
      client: client ?? createMockClient(),
      ...(directory && { directory }),
    },
    timerOverrides,
  )) as Promise<any>
}

describe('sidebar needsReauth (dead-fallback indicator)', () => {
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
          access: 'fallback-access',
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
          access: 'main-access',
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
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.needsReauth === false,
    )
    expect(state.fallbacks[0]?.needsReauth).toBe(false)
  })
})

async function readFeedEntries() {
  const directory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
  try {
    const files = await readdir(directory)
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
  globalThis.fetch = mock(() =>
    Promise.resolve(
      typeof response === 'function' ? response() : response.clone(),
    ),
  ) as unknown as typeof fetch
  const plugin = await getPlugin()
  const result = await plugin.auth.loader(
    () =>
      Promise.resolve({
        type: 'oauth',
        access: 'main-access',
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
  test('publishes a direct harvested response with the observation timestamp', async () => {
    const originalNow = Date.now
    let clock = 1_000_000
    Date.now = () => clock
    try {
      await useTempAccountFile({
        ...createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          mainAccountId: 'main-fixed-id',
        }),
        accounts: [],
      })
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.25',
              'anthropic-ratelimit-unified-5h-reset': '1800000000',
            },
          }),
        ),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
      })
      await response.text()
      clock += 1_000

      const feedDirectory = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR!
      await waitForFeedEntries(
        (entries) => entries.length === 1,
        'one published entry',
      )
      const files = await readdir(feedDirectory)
      expect(files).toHaveLength(1)
      const record = JSON.parse(
        await readFile(join(feedDirectory, files[0]!), 'utf8'),
      )
      const raw = await readFile(join(feedDirectory, files[0]!), 'utf8')
      const published = Object.values(record.entries)[0] as any
      expect(published).toEqual(
        expect.objectContaining({
          identity_source: 'account_ref',
          account_ref: 'main-fixed-id',
          configured_account_count: 1,
          observed_at_ms: 1_000_000,
          quota: expect.objectContaining({
            five_hour: expect.objectContaining({ checkedAt: 1_000_000 }),
          }),
        }),
      )
      expect(published).not.toHaveProperty('credential_id')
      for (const secret of [
        'main-access',
        'main-refresh',
        'test-access-token',
        'test-refresh-token',
        'authorization',
        'anthropic-ratelimit-unified-5h-utilization',
        'claude-sonnet-4-5',
        'vault',
        'credential_id',
      ]) {
        expect(raw).not.toContain(secret)
      }
      expect(raw).not.toContain('"credential_id":"main"')
      expect(raw).not.toContain('"account_ref":"main"')
    } finally {
      Date.now = originalNow
    }
  })

  test('cache-seeded poll fields survive a later header harvest into the feed', async () => {
    const originalNow = Date.now
    let clock = 1_000_000
    Date.now = () => clock
    try {
      const mainAccountId = 'cache-seeded-main'
      const accessToken = 'sk-ant-oat-cache-seeded'
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
      const extraUsage = {
        used: { amountMinor: 1261, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        utilizationPercent: 12.61,
        severity: 'normal',
        exhausted: false,
      }
      const storage = createFallbackStorage({
        mainAccountId,
        quotaHeaderFeed: { enabled: true },
        accounts: [],
        quota: {
          ...createFallbackStorage().quota,
          mainQuota: initialPollQuota,
          mainQuotaCheckedAt: pollCheckedAt,
          mainQuotaToken: tokenFingerprint(accessToken),
        },
      })
      await useTempAccountFile(storage)
      await saveAccountState(
        storage,
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        {
          mainQuota: true,
        },
      )
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
      globalThis.fetch = mock((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({ oauth_account: { account_uuid: mainAccountId } }),
          )
        }
        if (url.includes('/v1/messages')) {
          return Promise.resolve(
            new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.04',
                'anthropic-ratelimit-unified-7d-utilization': '0.52',
              },
            }),
          )
        }
        return Promise.resolve(Response.json({}))
      }) as unknown as typeof fetch
      // Keep the first header persistence pending to model a slower writer on the same host.
      const stateWriteLock = await acquireRefreshFileLock({
        name: 'state-write',
        ttlMs: 10_000,
        path: process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        renew: true,
      })
      if (!stateWriteLock) throw new Error('failed to hold account state lock')

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: accessToken,
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      const firstResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await firstResponse.text()

      const statePath = getAccountStatePath(
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
      )
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        main?: Record<string, unknown>
      }
      state.main = {
        ...(state.main ?? {}),
        quota: {
          ...initialPollQuota,
          scoped,
          extraUsage,
        },
        quotaCheckedAt: pollCheckedAt + 50_000,
        quotaToken: tokenFingerprint(accessToken),
      }
      await writeFile(statePath, `${JSON.stringify(state)}\n`)
      await stateWriteLock.release()
      await waitForAccountStorage(
        (loaded) => loaded?.quota?.mainQuotaCheckedAt === clock,
      )

      clock += 1_000
      const secondResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await secondResponse.text()
      const secondEntry = (
        await waitForFeedEntries(
          (entries) => entries.length === 1,
          'one published entry',
        )
      )[0] as any
      expect(secondEntry.quota.scoped).toEqual(scoped)
      expect(secondEntry.quota.extraUsage).toEqual(extraUsage)
      expect(secondEntry.quota.bindingWindow).toBe('claude-weekly-scoped-fable')
    } finally {
      Date.now = originalNow
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    }
  })

  test('stale fallback headers do not persist or publish after re-login', async () => {
    const fallbackAccess = 'fallback-lineage-a-access'
    const fallbackCheckedAt = Date.now()
    let releaseFallbackResponse: ((response: Response) => void) | undefined
    let fallbackStarted: (() => void) | undefined
    const fallbackResponse = new Promise<Response>((resolve) => {
      releaseFallbackResponse = resolve
    })
    const fallbackRequestStarted = new Promise<void>((resolve) => {
      fallbackStarted = resolve
    })
    await useTempAccountFile(
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
    )
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const records: LogTestRecord[] = []
    let fallbackAtPersistenceReject: unknown
    const sidebarStates: unknown[] = []
    try {
      const plugin = await getPlugin()
      setLogLevel('trace')
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'main-access',
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
          record.message ===
            'skipped stale fallback quota persistence after lineage change'
        ) {
          queueMicrotask(() => {
            fallbackAtPersistenceReject = quotaManager
              .getAllFallbacks()
              .get('fallback-1')
          })
        }
      })
      expect(
        quotaManager.getFallback('fallback-1', {
          authLineageId: 'lineage-a',
        }),
      ).not.toBeNull()
      const responsePromise = result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
      })
      await fallbackRequestStarted
      await drainSidebarWrites()
      __setSidebarStateWriteTestHooks({
        beforeRename: async (_stateFile, tempFile) => {
          sidebarStates.push(JSON.parse(await readFile(tempFile, 'utf8')))
        },
      })

      const replacement = await loadAccounts(
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
      )
      if (!replacement) throw new Error('fallback storage unexpectedly missing')
      const replacementAccount = replacement.accounts.find(
        (account) => account.id === 'fallback-1',
      )
      if (!replacementAccount || !isOAuthAccount(replacementAccount)) {
        throw new Error('fallback account unexpectedly missing')
      }
      replacementAccount.authLineageId = 'lineage-b'
      replacementAccount.quota = {
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
      }
      await saveAccounts(replacement)
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
          record.level === 'trace' &&
          record.channel === 'quota' &&
          record.message ===
            'skipped stale fallback quota persistence after lineage change' &&
          record.payload?.accountId === 'fallback-1' &&
          record.payload?.storedLineage === 'lineage-b' &&
          record.payload?.servedLineage === 'lineage-a',
        'stale fallback quota persistence discard',
      )
      await drainSidebarWrites()
      const settled = await loadAccounts()
      const settledAccount = settled?.accounts.find(
        (candidate) => candidate.id === 'fallback-1',
      )
      expect(
        settledAccount && isOAuthAccount(settledAccount)
          ? settledAccount.quota?.five_hour?.checkedAt
          : undefined,
      ).toBe(fallbackCheckedAt)
      expect(fallbackAtPersistenceReject).toBeUndefined()
      // A rejected harvest must not add a quota-only refresh that re-reads the
      // replacement account's newer persisted numbers.
      expect(
        sidebarStates.some(
          (state: any) =>
            state.fallbacks?.[0]?.quota?.five_hour?.usedPercent === 60,
        ),
      ).toBe(false)
      expect(await readFeedEntries()).toEqual([])
    } finally {
      __setLogTestSink(null)
      __setSidebarStateWriteTestHooks(null)
      setLogLevel('info')
    }
  })

  test('main-route sidebar writes use current fallback storage after re-login', async () => {
    const fallbackCheckedAt = Date.now()
    let releaseMainResponse: ((response: Response) => void) | undefined
    let mainStarted: (() => void) | undefined
    const mainResponse = new Promise<Response>((resolve) => {
      releaseMainResponse = resolve
    })
    const mainRequestStarted = new Promise<void>((resolve) => {
      mainStarted = resolve
    })
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
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
    )
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) {
        const token = new Headers(init?.headers).get('authorization')
        if (token === 'Bearer main-access') {
          mainStarted?.()
          return mainResponse
        }
        return Promise.resolve(new Response(null, { status: 429 }))
      }
      return Promise.resolve(Response.json({}))
    }) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      await drainSidebarWrites()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const quotaManager = plugin.__quotaManager
      expect(
        quotaManager.getAllFallbacks().get('fallback-1')?.quota.five_hour
          ?.usedPercent,
      ).toBe(25)

      const responsePromise = result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
      })
      await mainRequestStarted

      const replacement = await loadAccounts(
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
      )
      if (!replacement) throw new Error('fallback storage unexpectedly missing')
      const replacementAccount = replacement.accounts.find(
        (account) => account.id === 'fallback-1',
      )
      if (!replacementAccount || !isOAuthAccount(replacementAccount)) {
        throw new Error('fallback account unexpectedly missing')
      }
      replacementAccount.authLineageId = 'lineage-b'
      replacementAccount.quota = {
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
      }
      await saveAccounts(replacement)
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
    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/v1/messages')) {
        responseStarted()
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(Response.json({}))
    }) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'main-access',
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
      const accountIdentity = 'account-a'
      const accessToken = 'sk-ant-oat-cross-account-timestamp'
      await useTempAccountFile(
        createFallbackStorage({
          mainAccountId: 'main-slot',
          quotaHeaderFeed: { enabled: true },
          accounts: [],
        }),
      )
      globalThis.fetch = mock((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({ oauth_account: { account_uuid: accountIdentity } }),
          )
        }
        if (url.includes('/v1/messages')) {
          return Promise.resolve(
            new Response('{}', {
              status: 200,
              headers: {
                'anthropic-ratelimit-unified-5h-utilization': '0.04',
                'anthropic-ratelimit-unified-7d-utilization': '0.52',
              },
            }),
          )
        }
        return Promise.resolve(Response.json({}))
      }) as unknown as typeof fetch
      const stateWriteLock = await acquireRefreshFileLock({
        name: 'state-write',
        ttlMs: 10_000,
        path: process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        renew: true,
      })
      if (!stateWriteLock) throw new Error('failed to hold account state lock')

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: accessToken,
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )
      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      await response.text()

      const otherCheckedAt = 2_000_000
      const statePath = getAccountStatePath(
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
      )
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        main?: Record<string, unknown>
      }
      state.main = {
        ...(state.main ?? {}),
        quota: {
          source: 'poll',
          accountIdentity: 'account-b',
          checkedAt: otherCheckedAt,
          five_hour: {
            usedPercent: 80,
            remainingPercent: 20,
            checkedAt: otherCheckedAt,
          },
        },
        quotaCheckedAt: otherCheckedAt,
        quotaToken: tokenFingerprint('sk-ant-oat-account-b'),
      }
      await writeFile(statePath, `${JSON.stringify(state)}\n`)
      await stateWriteLock.release()
      await waitForAccountStorage(
        (loaded) => loaded?.quota?.mainQuotaCheckedAt === otherCheckedAt,
      )

      const published = (
        await waitForFeedEntries(
          (entries) =>
            entries.length === 1 &&
            (entries[0] as any)?.account_ref === accountIdentity,
          'one account-a published entry',
        )
      )[0] as any
      expect(published.account_ref).toBe(accountIdentity)
      expect(published.observed_at_ms).toBe(requestCheckedAt)
      expect(published.observed_at_ms).not.toBe(otherCheckedAt)
    } finally {
      Date.now = originalNow
    }
  })

  test('withholds the main feed entry when bootstrap cannot identify the account', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId: 'unknown-main',
        quotaHeaderFeed: { enabled: true },
        accounts: [],
      }),
    )
    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/v1/messages')) {
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.04',
              'anthropic-ratelimit-unified-7d-utilization': '0.52',
            },
          }),
        )
      }
      return Promise.resolve(Response.json({}))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat-unknown-feed',
          refresh: 'unknown-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    await response.text()
    expect(await readFeedEntries()).toEqual([])
  })

  test('main account replacement fences quota, backoff, and feed identity', async () => {
    const originalProfileHydration =
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    try {
      await useTempAccountFile({
        ...createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          mainAccountId: 'main-slot',
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            failClosedOnUnknownQuota: false,
          },
        }),
        accounts: [],
      })

      let releaseOldPoll!: (response: Response) => void
      let oldPollEntered!: () => void
      const oldPollStarted = new Promise<void>((resolve) => {
        oldPollEntered = resolve
      })
      const oldPoll = new Promise<Response>((resolve) => {
        releaseOldPoll = resolve
      })
      globalThis.fetch = mock((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/claude_cli/bootstrap')) {
          const token = new Headers(init?.headers).get('authorization')
          return Promise.resolve(
            Response.json({
              oauth_account: {
                account_uuid: token?.includes('token-a')
                  ? 'account-a'
                  : 'account-b',
              },
            }),
          )
        }
        if (url.includes('/api/oauth/usage')) {
          const token = new Headers(init?.headers).get('authorization')
          if (token?.includes('token-a')) {
            oldPollEntered()
            return oldPoll
          }
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 20 },
            }),
          )
        }
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.2',
              'anthropic-ratelimit-unified-5h-reset': '1800000000',
              'anthropic-ratelimit-unified-7d-utilization': '0.3',
              'anthropic-ratelimit-unified-7d-reset': '1800000000',
            },
          }),
        )
      }) as unknown as typeof fetch

      const plugin = await getPlugin()
      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat-token-a',
            refresh: 'refresh-a',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const quotaManager = plugin.__quotaManager
      const checkedAt = Date.now()
      quotaManager.setMain('account-a', {
        quota: {
          accountIdentity: 'account-a',
          five_hour: {
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt,
          },
        },
        refreshAfter: checkedAt + 300_000,
        checkedAt,
      })
      const priorPoll = quotaManager.refreshMain(
        'account-a',
        'sk-ant-oat-token-a',
      )
      await oldPollStarted

      const resultB = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat-token-b',
            refresh: 'refresh-b',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      expect(quotaManager.getMain('account-b')).toBeNull()
      const replacementPoll = quotaManager.refreshMain(
        'account-b',
        'sk-ant-oat-token-b',
      )
      releaseOldPoll(new Response('rate limited', { status: 429 }))
      await expect(priorPoll).rejects.toThrow('429')
      await replacementPoll

      expect(quotaManager.getMain('account-a')).toBeNull()
      expect(quotaManager.getMain('account-b')?.quota.five_hour).toEqual(
        expect.objectContaining({ remainingPercent: 90 }),
      )
      expect(quotaManager.isBackedOff()).toBe(false)

      const response = await resultB.fetch(MESSAGES_URL, EMPTY_POST)
      await response.text()
      expect(quotaManager.getMain('account-b')?.quota.accountIdentity).toBe(
        'account-b',
      )
      const entries = await waitForFeedEntries(
        (candidate) =>
          candidate.length === 1 &&
          candidate.some((entry: any) => entry.account_ref === 'account-b'),
        'one account-b published entry',
      )
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            identity_source: 'account_ref',
            account_ref: 'account-b',
          }),
        ]),
      )
      expect(entries).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account_ref: 'account-a' }),
        ]),
      )
    } finally {
      if (originalProfileHydration === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION =
          originalProfileHydration
      }
    }
  })

  test('sustained unknown account identity retains the fail-closed spend gate', async () => {
    const now = Date.now()
    await useTempAccountFile({
      ...createFallbackStorage({
        mainAccountId: 'main-slot',
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          failClosedOnUnknownQuota: true,
          mainQuota: {
            accountIdentity: 'account-a',
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
            accountIdentity: 'account-a',
          },
        },
      }),
      accounts: [],
    })
    let messageCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/claude_cli/bootstrap')) {
        return Promise.resolve(
          new Response('bootstrap unavailable', { status: 503 }),
        )
      }
      if (url.includes('/v1/messages')) {
        messageCalls += 1
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(new Response('not-mocked', { status: 599 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat-unknown',
          refresh: 'refresh-b',
          expires: now + 100_000,
        }),
      { models: {} },
    )
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(429)
    expect(messageCalls).toBe(0)
    expect(plugin.__quotaManager.isBackedOff()).toBe(true)
  })

  test('confirmed account replacement clears the prior account backoff', async () => {
    const now = Date.now()
    await useTempAccountFile({
      ...createFallbackStorage({
        mainAccountId: 'main-slot',
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          failClosedOnUnknownQuota: true,
          mainLastQuotaApiError: {
            message: 'account A quota backoff',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            retryCount: 1,
            accountIdentity: 'account-a',
          },
          mainQuotaErrorGeneration: 1,
        },
      }),
      accounts: [],
    })
    let messageCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/claude_cli/bootstrap')) {
        return Promise.resolve(
          Response.json({ oauth_account: { account_uuid: 'account-b' } }),
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
      if (url.includes('/v1/messages')) messageCalls += 1
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat-account-b',
          refresh: 'refresh-b',
          expires: now + 100_000,
        }),
      { models: {} },
    )
    expect(plugin.__quotaManager.getMainQuotaErrorGeneration()).toBe(2)

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(messageCalls).toBe(1)
    expect(plugin.__quotaManager.isBackedOff()).toBe(false)
    expect((await loadAccounts())?.quota?.mainLastQuotaApiError).toBeUndefined()
    expect((await loadAccounts())?.quota?.mainQuotaErrorGeneration).toBe(2)
  })

  test('discards main response headers resolved under a replaced identity', async () => {
    const originalProfileHydration =
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    try {
      await useTempAccountFile({
        ...createFallbackStorage({
          quotaHeaderFeed: { enabled: true },
          mainAccountId: 'main-slot',
          quota: { enabled: true, checkIntervalMinutes: 5 },
        }),
        accounts: [],
      })
      let releaseResponse!: (response: Response) => void
      let responseStarted!: () => void
      const response = new Promise<Response>((resolve) => {
        releaseResponse = resolve
      })
      const started = new Promise<void>((resolve) => {
        responseStarted = resolve
      })
      globalThis.fetch = mock((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/claude_cli/bootstrap')) {
          const token = new Headers(init?.headers).get('authorization')
          return Promise.resolve(
            Response.json({
              oauth_account: {
                account_uuid: token?.includes('token-a')
                  ? 'account-a'
                  : 'account-b',
              },
            }),
          )
        }
        if (url.includes('/v1/messages')) {
          responseStarted()
          return response
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch

      const plugin = await getPlugin()
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      setLogLevel('trace')
      const tokenA = 'sk-ant-oat-race-token-a'
      const tokenB = 'sk-ant-oat-race-token-b'
      const resultA = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: tokenA,
            refresh: 'refresh-a',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const inFlight = resultA.fetch(MESSAGES_URL, EMPTY_POST)
      await started

      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: tokenB,
            refresh: 'refresh-b',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      releaseResponse(
        new Response('{}', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.1',
            'anthropic-ratelimit-unified-5h-reset': '1800000000',
            'anthropic-ratelimit-unified-7d-utilization': '0.2',
            'anthropic-ratelimit-unified-7d-reset': '1800000000',
          },
        }),
      )
      expect((await inFlight).status).toBe(200)

      // The stale-identity trace is emitted before any feed writer can start.
      await waitForLogRecord(
        records,
        (record) =>
          record.level === 'trace' &&
          record.channel === 'quota' &&
          record.message === 'discarded stale main quota headers',
        'stale main quota header discard',
      )
      const entries = await readFeedEntries()
      expect(entries).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account_ref: 'account-a' }),
        ]),
      )
      expect(plugin.__quotaManager.getMain('account-a')).toBeNull()
    } finally {
      __setLogTestSink(null)
      setLogLevel('info')
      if (originalProfileHydration === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION =
          originalProfileHydration
      }
    }
  })

  test('coalesces concurrent main identity resolution for the same token', async () => {
    const originalProfileHydration =
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    try {
      await useTempAccountFile({
        ...createFallbackStorage({
          mainAccountId: 'main-slot',
          quota: { enabled: false },
        }),
        accounts: [],
      })
      let releaseBootstrap!: (response: Response) => void
      const bootstrapResponse = new Promise<Response>((resolve) => {
        releaseBootstrap = resolve
      })
      let bootstrapStarted!: () => void
      const bootstrapStartedPromise = new Promise<void>((resolve) => {
        bootstrapStarted = resolve
      })
      let bootstrapCalls = 0
      globalThis.fetch = mock((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/claude_cli/bootstrap')) {
          bootstrapCalls++
          bootstrapStarted()
          return bootstrapResponse
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch

      const plugin = await getPlugin()
      let currentAuth = {
        type: 'oauth' as const,
        access: 'compat-main-access',
        refresh: 'main-refresh',
        expires: Date.now() + 100_000,
      }
      const result = await plugin.auth.loader(
        () => Promise.resolve(currentAuth),
        { models: {} },
      )
      currentAuth = {
        ...currentAuth,
        access: 'sk-ant-oat-shared-token',
      }

      const firstRequest = result.fetch(MESSAGES_URL, EMPTY_POST)
      await bootstrapStartedPromise
      const secondRequest = result.fetch(MESSAGES_URL, EMPTY_POST)
      releaseBootstrap(
        Response.json({ oauth_account: { account_uuid: 'shared-account' } }),
      )

      const responses = await Promise.all([firstRequest, secondRequest])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(bootstrapCalls).toBe(1)
    } finally {
      if (originalProfileHydration === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION =
          originalProfileHydration
      }
    }
  })

  test('aborts a request whose main identity becomes stale during resolution', async () => {
    const originalProfileHydration =
      process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    try {
      await useTempAccountFile({
        ...createFallbackStorage({
          mainAccountId: 'main-slot',
          quota: { enabled: false },
        }),
        accounts: [],
      })
      let releaseBootstrapA!: (response: Response) => void
      const bootstrapA = new Promise<Response>((resolve) => {
        releaseBootstrapA = resolve
      })
      let bootstrapAStarted!: () => void
      const bootstrapAStartedPromise = new Promise<void>((resolve) => {
        bootstrapAStarted = resolve
      })
      let bootstrapCalls = 0
      globalThis.fetch = mock((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/api/claude_cli/bootstrap')) {
          bootstrapCalls += 1
          const token = new Headers(init?.headers).get('authorization')
          if (token?.endsWith('resolution-a')) {
            bootstrapAStarted()
            return bootstrapA
          }
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: 'account-b' },
            }),
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch

      const plugin = await getPlugin()
      const tokenA = 'sk-ant-oat-race-resolution-a'
      const tokenB = 'sk-ant-oat-race-resolution-b'
      let currentAuthA = {
        type: 'oauth' as const,
        access: 'compat-a',
        refresh: 'refresh-a',
        expires: Date.now() + 100_000,
      }
      const resultA = await plugin.auth.loader(
        () => Promise.resolve(currentAuthA),
        { models: {} },
      )
      currentAuthA = { ...currentAuthA, access: tokenA }
      const requestA = resultA.fetch(MESSAGES_URL, EMPTY_POST)
      await bootstrapAStartedPromise

      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: tokenB,
            refresh: 'refresh-b',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      releaseBootstrapA(
        Response.json({ oauth_account: { account_uuid: 'account-a' } }),
      )

      await expect(requestA).rejects.toThrow(
        'Main OAuth identity changed while resolving request credentials',
      )
      expect(bootstrapCalls).toBe(2)
    } finally {
      if (originalProfileHydration === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION =
          originalProfileHydration
      }
    }
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
        void loadAccounts().then((storage) =>
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
    const first = (await loadAccounts())?.mainAccountId
    await plugin.auth.loader(auth, { models: {} })
    const second = (await loadAccounts())?.mainAccountId

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
  test('returns an object with auth properties', async () => {
    const plugin = await getPlugin()
    expect(plugin.auth).toBeDefined()
    expect(plugin.auth.provider).toBe('anthropic')
    expect(plugin.auth.loader).toBeFunction()
    expect(plugin.auth.methods).toBeArray()
    expect(plugin.provider?.id).toBe('anthropic')
    expect(plugin.provider?.models).toBeFunction()
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
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
        }),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

  test('deduplicates main feed observations across access-token rotation', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        mainAccountId: 'stable-main-account',
        quotaHeaderFeed: { enabled: true },
        accounts: [],
        quota: { enabled: false },
      }),
    )
    let requestCount = 0
    globalThis.fetch = mock(() => {
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
    }) as unknown as typeof fetch
    const plugin = await getPlugin()

    for (const access of ['main-access-a', 'main-access-b']) {
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access,
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
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: 'stable-main-account',
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
            access: 'unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires: Date.now() + 5 * 60 * 60_000,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage'))
        return Promise.reject(new Error('quota source unavailable'))
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(authorizations).toContain('Bearer unknown-fallback-access')
  })

  test('ordered fallback admission rejects unknown-quota OAuth under fail-closed', async () => {
    await expectUnknownQuotaAdmissionBlocked(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'unknown-fallback-access',
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
      },
      undefined,
    ]) {
      const storage = createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: {
          ...createFallbackStorage().quota,
          failClosedOnUnknownQuota: false,
        },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires: now + 1_000,
            lastRefreshError,
          },
        ],
      })
      await useTempAccountFile(storage)
      if (lastRefreshError) {
        await saveAccountState(
          storage,
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
          { accounts: true },
        )
      }
      const messageAuthorizations: string[] = []
      globalThis.fetch = mock((input: any, init?: RequestInit) => {
        const url = extractUrl(input)
        if (url.includes('/v1/oauth/token'))
          return Promise.resolve(
            Response.json({
              access_token: 'refreshed-fallback-access',
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
      }) as unknown as typeof fetch
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
      if (lastRefreshError) {
        expect(messageAuthorizations).not.toContain(
          'Bearer unknown-fallback-access',
        )
      } else {
        expect(response.status).toBe(200)
        expect(messageAuthorizations).toContain(
          'Bearer refreshed-fallback-access',
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
            access: 'unknown-fallback-access',
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
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage'))
        return Promise.reject(new Error('quota source unavailable'))
      if (url.includes('/v1/messages')) messageRequests.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage'))
        return Promise.reject(new Error('quota source unavailable'))
      if (url.includes('/v1/messages')) messageRequests.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/messages')) messageRequests.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
    const mainAccountId = (await loadAccounts())?.mainAccountId
    expect(mainEntries[0]).toEqual(
      expect.objectContaining({
        identity_source: 'account_ref',
        account_ref: mainAccountId,
      }),
    )
    expect(mainEntries[0]).not.toHaveProperty('credential_id')

    const fallback = await loadMainAndFetch(
      createFallbackStorage({
        quotaHeaderFeed: { enabled: true },
        routing: { mode: 'fallback-first' },
      }),
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
          { id: 'disabled-oauth', type: 'oauth', refresh: 'r', enabled: false },
          { id: 'enabled-oauth', type: 'oauth', refresh: 'r', enabled: true },
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

describe('provider.models', () => {
  beforeEach(async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
  })

  afterEach(async () => {
    await drainSidebarWrites()
    restoreProcessTestFiles()
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true })
      tempConfigDir = undefined
    }
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
    expect(models['claude-opus-4-8'].cost).toEqual({
      input: 5,
      output: 25,
      cache: { read: 0.5, write: 6.25 },
    })
  })

  test('keeps Anthropic API-key model costs unchanged and prices Fable 5', async () => {
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
    globalThis.fetch = originalFetch
    pluginTimerOverrides = {}
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
    globalThis.fetch = originalFetch
    pluginTimerOverrides = {}
    Math.random = originalRandom
    Date.now = originalDateNow
    resetNotificationsForTest()
    __setInitialSidebarRoutingTestHooks(null)
    __setSidebarStateWriteTestHooks(null)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await drainSidebarWrites()
    restoreProcessTestFiles()
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true })
      tempConfigDir = undefined
    }
  })

  test('returns empty object for non-oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve({ type: 'api' }),
      { models: {} },
    )
    expect(result).toEqual({})
  })

  test('returns fetch wrapper for oauth auth', async () => {
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
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
          access: 'main-access',
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
            access: 'work-access',
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
          access: 'main-access',
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
            access: 'work-access',
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
          access: 'main-access',
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
            access: 'work-access',
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
          access: 'main-access',
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
            access: 'work-access',
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
    await saveAccounts(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        quota: {
          ...createFallbackStorage().quota,
          failClosedOnUnknownQuota: false,
        },
        accounts: [
          {
            id: 'work-2',
            type: 'oauth',
            access: 'work-2-access',
            refresh: 'work-2-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    expect(
      (await loadAccounts())?.accounts.some(
        (account) => account.id === 'work-2',
      ),
    ).toBe(true)
    await seedSidebarRouting('work-2', 'fallback-first', Date.now())

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    await saveAccounts(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-fresh',
            type: 'oauth',
            access: 'work-fresh-access',
            refresh: 'work-fresh-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    await seedSidebarRouting('main', 'main', Date.now())

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
        accounts: [
          {
            id: 'work-deleted',
            type: 'oauth',
            access: 'work-deleted-access',
            refresh: 'work-deleted-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    const plugin = await getPlugin()
    // v1.16.0's mergeAccountsForSave unions existing+incoming accounts, so a
    // deletion must be declared explicitly via removedAccountIds — a plain
    // save without the account no longer removes it.
    await saveAccounts(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'work-current',
            type: 'oauth',
            access: 'work-current-access',
            refresh: 'work-current-refresh',
            expires: Date.now() + 100000,
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
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await drainSidebarWrites()

    const state = await getSidebarState()
    expect(state.activeId).toBe('work-current')
    expect(state.route).toBe('fallback-first')
    expect(state.fallbacks.map((account) => account.id)).toEqual([
      'work-current',
    ])
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
          access: 'main-access',
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
          access: 'main-access',
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
          access: 'main-access',
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
          access: 'main-access',
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
          command: 'claude-quota',
          arguments: '',
          sessionID: 'session-1',
        }),
      )
      const accountFile = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
      if (!accountFile) throw new Error('Expected isolated account file')
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
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-quota',
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
            access: 'fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: Date.now() + 100000,
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'fallback-b-access',
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
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await seedSidebarRouting('fallback-b', 'fallback-first', Date.now())

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-quota',
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
        command: 'claude-quota',
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
            access: 'work-access',
            refresh: 'work-refresh',
            expires: Date.now() + 100000,
          },
        ],
      }),
    )
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
            mainQuotaToken: tokenFingerprint('main-access'),
          },
        }),
      )

      globalThis.fetch = mock((_input: any, _init: any) =>
        Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        ),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'main-access',
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
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(`${start}${delta}`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'main-access',
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
    const storage = await loadAccounts()
    expect(storage).not.toBeNull()
    ;(storage as AccountStorage).quota = {
      ...(storage as AccountStorage).quota,
      mainQuota: {
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
      },
      mainQuotaCheckedAt: Date.now(),
      mainQuotaToken: tokenFingerprint('main-access'),
    }
    await saveAccountState(storage as AccountStorage, undefined, {
      mainQuota: true,
    })

    let quotaApiCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) quotaApiCalls++
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )

    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
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

      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    expect(authorizations[0]).toBe('Bearer fallback-access')
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

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
          access: 'main-access',
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
        command: 'claude-cachekeep',
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
      createFallbackStorage({
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
                checkedAt: Date.now(),
              },
            ],
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('main-access'),
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'fallback-1',
            type: 'oauth',
            access: 'fallback-access',
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
    )

    const authorizations: string[] = []
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
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    expect(authorizations).toEqual(['Bearer fallback-access'])
  })

  test('keeps non-Fable requests on main when only main Fable quota is exhausted', async () => {
    await useTempAccountFile(
      createFallbackStorage({
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
                checkedAt: Date.now(),
              },
            ],
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('main-access'),
        } as AccountStorage['quota'],
      }),
    )

    const authorizations: string[] = []
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
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    expect(authorizations).toEqual(['Bearer main-access'])
  })

  test('does not route API-key fallback for scoped Fable exhaustion alone', async () => {
    await useTempAccountFile(
      createFallbackStorage({
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
                checkedAt: Date.now(),
              },
            ],
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('main-access'),
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
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer main-access',
    })
  })

  test('refreshes stale scoped Fable exhaustion before skipping main', async () => {
    await useTempAccountFile(
      createFallbackStorage({
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
                checkedAt: Date.now() - 60 * 60 * 1000,
              },
            ],
          },
          mainQuotaCheckedAt: Date.now() - 60 * 60 * 1000,
          mainQuotaToken: tokenFingerprint('main-access'),
        } as AccountStorage['quota'],
      }),
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    let quotaCalls = 0
    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    expect(requests[0]?.authorization).toBe('Bearer main-access')
  })

  test('killswitch fallback handoff filters exhausted matching scoped model quota', async () => {
    const now = Date.now()
    await useTempAccountFile(
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
            five_hour: { usedPercent: 70, remainingPercent: 30 },
            seven_day: { usedPercent: 10, remainingPercent: 90 },
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
          mainQuotaToken: tokenFingerprint('main-access'),
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'fallback-empty',
            type: 'oauth',
            access: 'fallback-empty-access',
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
            access: 'fallback-ok-access',
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
    )

    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
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
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    expect(authorizations).toEqual(['Bearer fallback-ok-access'])
  })

  test('does not route to API-key fallback when main OAuth quota is low but not exhausted', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          mainQuota: {
            five_hour: { usedPercent: 99, remainingPercent: 1 },
            seven_day: { usedPercent: 99, remainingPercent: 1 },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('main-access'),
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
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    expect(requests[0]?.authorization).toBe('Bearer main-access')
  })

  test('routes to API-key fallback when cached main OAuth quota is exhausted', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          mainQuota: {
            five_hour: { usedPercent: 100, remainingPercent: 0 },
            seven_day: { usedPercent: 50, remainingPercent: 50 },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: tokenFingerprint('main-access'),
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
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          mainQuota: {
            five_hour: { usedPercent: 100, remainingPercent: 0 },
            seven_day: { usedPercent: 50, remainingPercent: 50 },
          },
          mainQuotaCheckedAt: Date.now() - 60 * 60 * 1000,
          mainQuotaToken: tokenFingerprint('main-access'),
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
    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      authorization: 'Bearer main-access',
    })
  })

  test('does not use API-key route in fallback-first before main quota is exhausted', async () => {
    await useTempAccountFile(
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
            access: 'fallback-access',
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
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      authorization: 'Bearer fallback-access',
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
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      const headers = new Headers(init?.headers)
      const authorization = headers.get('authorization')
      if (url.includes('/api/oauth/usage')) {
        quotaCalls++
        expect(authorization).toBe('Bearer main-access')
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
        return Promise.resolve(new Response('main exhausted', { status: 429 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      authorization: 'Bearer main-access',
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
    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      authorization: 'Bearer main-access',
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
    globalThis.fetch = mock((input: any, init: any) => {
      requests.push({
        url: extractUrl(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(new Response('auth failure', { status: 403 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      authorization: 'Bearer main-access',
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
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        mainQuotaCalls++
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer main-access',
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

      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    expect(authorizations[0]).toBe('Bearer fallback-access')
  })

  test('fetch wrapper sets OAuth headers and prefixes tools', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))

    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined

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
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
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
    expect(capturedHeaders!.get('authorization')).toBe('Bearer my-access-token')
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
    )

    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined
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
      capturedUrl = url
      capturedBody = init?.body
      capturedHeaders = new Headers(init?.headers)
      return Promise.resolve(
        new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
      )
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
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

    expect(capturedUrl).toBe('https://relay.example.test')
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
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))

    let capturedUrl: string | undefined
    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await saveAccounts(
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
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-abc' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        system: 'system',
      }),
    })

    expect(capturedUrl).toBe('https://relay.example.test')
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
    )

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await saveAccounts(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: true,
          transport: 'websocket',
        },
      }),
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: new Uint8Array([123, 125]),
    })

    const state = await waitForSidebarState(
      (value) => value.relay?.transport === 'websocket',
    )
    expect(state.relay).toEqual({ enabled: true, transport: 'websocket' })
  })

  test('registers and handles /claude-cache slash command with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const config: { command?: Record<string, unknown> } = {}

    await plugin.config(config)

    expect(config.command?.['claude-cache']).toMatchObject({
      template: 'claude-cache',
      description: expect.stringContaining('1-hour'),
    })
    expect(config.command?.['claude-quota']).toMatchObject({
      template: 'claude-quota',
      description: expect.stringContaining('Claude OAuth quota'),
    })
    expect(config.command?.['claude-dump']).toMatchObject({
      template: 'claude-dump',
      description: expect.stringContaining('dump'),
    })
    expect(config.command?.['claude-fast']).toMatchObject({
      template: 'claude-fast',
      description: expect.stringContaining('fast mode'),
    })
    expect(config.command?.['claude-cachekeep']).toMatchObject({
      template: 'claude-cachekeep',
      description: expect.stringContaining('cache warm'),
    })
    expect(config.command?.['claude-routing']).toMatchObject({
      template: 'claude-routing',
      description: expect.stringContaining('account routing'),
    })

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-cache',
        arguments: 'on',
        sessionID: 'session-1',
      }),
    )

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('## Claude Cache Enabled'),
          },
        ],
      },
    })

    await expect(
      plugin['command.execute.before']({
        command: 'claude-cache',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain('- Enabled: enabled')

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.claudeCache).toEqual({ enabled: true, mode: 'explicit' })
  })

  test('config hook registers every modal command so they appear in the command palette', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const plugin = await getPlugin()

    // Seed a pre-existing command from another plugin / opencode itself — the
    // config hook must MERGE into config.command, never clobber it.
    const preExisting = { template: 'other-plugin-cmd', description: 'foreign' }
    const result: { command?: Record<string, unknown> } = {
      command: { 'other-plugin-cmd': preExisting },
    }
    await plugin.config(result)

    const registered = Object.keys(result.command ?? {})

    // Passthrough-survival: the foreign command must still be present (the hook
    // spreads ...(config.command ?? {}) — dropping that spread would silently
    // wipe every other plugin's commands).
    expect(result.command?.['other-plugin-cmd']).toEqual(preExisting)

    // Every modal command must be registered — if one is missing it won't appear
    // in the slash-command palette and users will get "No matching items".
    for (const name of COMMAND_MODAL_NAMES) {
      expect(registered).toContain(name)
    }

    // The config hook must not register extra claude-* commands beyond the
    // shared modal-command set (drift in either direction is a bug). The foreign
    // 'other-plugin-cmd' is excluded from this count via the claude- prefix.
    const claudeRegistered = registered.filter((name) =>
      name.startsWith('claude-'),
    )
    expect(claudeRegistered).toHaveLength(COMMAND_MODAL_NAMES.length)
    expect([...claudeRegistered].sort()).toEqual(
      [...COMMAND_MODAL_NAMES].sort(),
    )
  })

  test('handles /claude-start by injecting one visible synthetic prompt', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-start',
        arguments: '',
        sessionID: 'session-start',
      }),
    )

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
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-cachekeep',
        arguments: '09-23',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain(
      '## Claude Cache Keep Enabled',
    )
    expect(latestCall?.body.parts[0]?.text).toContain('Schedule: 09-23')
    expect(latestCall?.body.parts[0]?.text).toContain('Hybrid active: yes')

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.cacheKeep).toEqual({
      enabled: true,
      always: false,
      startHour: 9,
      endHour: 23,
    })

    await expect(
      plugin['command.execute.before']({
        command: 'claude-cachekeep',
        arguments: 'always',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const always = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(always.cacheKeep).toEqual({ enabled: true, always: true })
  })

  test('registers and handles /claude-fast slash command with ignored status replies', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-fast',
        arguments: 'on',
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
            text: expect.stringContaining('## Claude Fast Mode Enabled'),
          },
        ],
      },
    })

    await expect(
      plugin['command.execute.before']({
        command: 'claude-fast',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain('- Enabled: enabled')

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.claudeFast).toEqual({ enabled: true })
  })

  test('handles /claude-routing slash command and persists routing mode', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-routing',
        arguments: 'sticky-balanced',
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
            text: expect.stringContaining('Mode updated to `sticky-balanced`.'),
          },
        ],
      },
    })

    await expect(
      plugin['command.execute.before']({
        command: 'claude-routing',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain(
      '- Mode: `sticky-balanced`',
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude-routing',
        arguments: 'reset',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const resetCall = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls.at(-1)?.[0]
    expect(resetCall?.body.parts[0]?.text).toContain(
      'Claude Routing Assignment Reset',
    )

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.routing).toEqual({ mode: 'sticky-balanced' })
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
        command: 'claude-cache',
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
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-dump',
        arguments: 'on',
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
            text: expect.stringContaining('## Claude Dump Enabled'),
          },
        ],
      },
    })

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.dump).toEqual({ enabled: true })
  })

  test('handles /claude-cache mode command and persists cache strategy', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
    )
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-cache',
        arguments: 'mode hybrid',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.claudeCache).toEqual({ enabled: true, mode: 'hybrid' })

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session-1' },
      body: {
        noReply: true,
        parts: [
          {
            type: 'text',
            ignored: true,
            text: expect.stringContaining('Mode updated to `hybrid`.'),
          },
        ],
      },
    })
  })

  test('handles /claude-quota before auth loader has run', async () => {
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-quota',
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
            access: 'fallback-access',
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
      (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/oauth/usage')) {
          const authorization = new Headers(init?.headers).get('authorization')
          if (authorization) seenTokens.push(authorization)
          const utilization = authorization === 'Bearer main-access' ? 25 : 40
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
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude-quota',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(seenTokens).toContain('Bearer main-access')
    expect(
      seenTokens.filter((token) => token === 'Bearer fallback-access').length,
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
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    let profileSignal: AbortSignal | undefined
    globalThis.fetch = mock(
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
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 25 },
              seven_day: { utilization: 50 },
            }),
          )
        }
        return Promise.resolve(new Response('ok'))
      },
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const startedAt = performance.now()
    await expect(
      plugin['command.execute.before']({
        command: 'claude-quota',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(performance.now() - startedAt).toBeLessThan(4_000)
    expect(profileSignal?.aborted).toBe(true)
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
    globalThis.fetch = mock((input: string | URL | Request) => {
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
    }) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    const configLock = await acquireRefreshFileLock({
      name: 'config-write',
      path: process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
      ttlMs: 10_000,
      renew: true,
    })
    expect(configLock).not.toBeNull()
    if (!configLock) throw new Error('expected account config lock')

    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-quota',
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
      expect((await loadAccounts())?.main?.profile).toBeUndefined()
    } finally {
      await configLock.release()
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
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    for (let call = 0; call < 2; call++) {
      await expect(
        plugin['command.execute.before']({
          command: 'claude-quota',
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

    expect(profileCalls).toEqual([
      'Bearer main-access',
      'Bearer fallback-access',
    ])
    const loaded = await loadAccounts()
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
            tokenFingerprint: tokenFingerprint('main-access'),
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
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude-quota',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('legacy profile is adopted under the current main identity', async () => {
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
            tokenFingerprint: tokenFingerprint('old-access'),
          },
        },
      }),
    )
    const mockClient = createMockClient()
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) =>
      Promise.resolve(
        (() => {
          if (extractUrl(input).includes('/api/oauth/profile')) {
            profileCalls++
            return new Response('failed', { status: 500 })
          }
          return new Response('ok')
        })(),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'new-access',
          refresh: 'new-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude-account',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const text = (mockClient.session.promptAsync as any).mock.calls.at(-1)?.[0]
      ?.body.parts[0]?.text

    expect(text).toContain('Max 20x')
    expect(profileCalls).toBe(0)
    const adoptedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile?.accountIdentity !== undefined,
    )
    expect(adoptedStorage?.main?.profile?.accountIdentity).toBe(
      adoptedStorage?.mainAccountId,
    )
  })

  test('in-flight hydration is shared across access-token rotation', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    let liveAccess = 'token-a'
    let profileCalls = 0
    let resolveFirstProfile!: (response: Response) => void
    let markProfileStarted!: () => void
    const profileStarted = new Promise<void>((resolve) => {
      markProfileStarted = resolve
    })
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (!extractUrl(input).includes('/api/oauth/profile')) {
        return Promise.resolve(new Response('ok'))
      }
      profileCalls++
      if (profileCalls === 1) {
        markProfileStarted()
        return new Promise<Response>((resolve) => {
          resolveFirstProfile = resolve
        })
      }
      return Promise.resolve(
        Response.json({
          organization: {
            organization_type: 'claude_team',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
      )
    }) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: liveAccess,
          refresh: `refresh-${liveAccess}`,
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const firstCommand = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-account',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await profileStarted

    liveAccess = 'token-b'
    const command = expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude-account',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    await Bun.sleep(25)
    resolveFirstProfile(
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
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('main-access'),
          },
        },
      }),
    )
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude-account',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
    expect((await loadAccounts())?.main?.profile?.tier).toBe(
      'default_claude_max_20x',
    )
  })

  test('boot profile hydration publishes tier labels to the sidebar', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let profileCalls = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
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
    }) as unknown as typeof fetch
    const plugin = await getPlugin()

    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
            tier: 'default_claude_max_20x',
            orgType: 'claude_max',
            checkedAt: Date.now(),
            tokenFingerprint: tokenFingerprint('main-access'),
          },
        },
        accounts: [
          {
            id: 'fb',
            type: 'oauth',
            access: 'old-access',
            refresh: 'old-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
            lastRefreshedAt: 100,
          },
        ],
      }),
    )
    let resolveProfile!: (response: Response) => void
    let markProfileStarted!: () => void
    let profileCalls = 0
    const profileStarted = new Promise<void>((resolve) => {
      markProfileStarted = resolve
    })
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) {
        profileCalls++
        markProfileStarted()
        return new Promise<Response>((resolve) => {
          resolveProfile = resolve
        })
      }
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await profileStarted
    await drainSidebarWrites()
    const initialSidebarUpdatedAt = (await getSidebarState()).lastUpdated

    const rotated = await loadAccounts()
    const fallback = rotated?.accounts[0]
    if (!rotated || fallback?.type !== 'oauth') {
      throw new Error('expected fallback OAuth account')
    }
    fallback.access = 'new-access'
    fallback.refresh = 'new-refresh'
    fallback.lastRefreshedAt = 200
    await saveAccounts(rotated)
    await Bun.sleep(2)
    resolveProfile(
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

    const reloaded = await loadAccounts()
    const reloadedFallback = reloaded?.accounts[0]
    expect(reloadedFallback).toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
      lastRefreshedAt: 200,
    })
    if (reloadedFallback?.type !== 'oauth') {
      throw new Error('expected reloaded fallback OAuth account')
    }
    expect(reloadedFallback.profile).toMatchObject({
      tier: 'default_claude_max_5x',
      accountIdentity: 'fb',
    })
    expect(profileCalls).toBe(1)
  })

  test('late main profile hydration cannot replace a rotated-token profile', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let liveAccess = 'old-main-access'
    let resolveProfile!: (response: Response) => void
    let markProfileStarted!: () => void
    const profileStarted = new Promise<void>((resolve) => {
      markProfileStarted = resolve
    })
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) {
        markProfileStarted()
        return new Promise<Response>((resolve) => {
          resolveProfile = resolve
        })
      }
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: liveAccess,
          refresh: `refresh-${liveAccess}`,
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await profileStarted
    await drainSidebarWrites()
    const initialSidebarUpdatedAt = (await getSidebarState()).lastUpdated

    liveAccess = 'new-main-access'
    const rotated = await loadAccounts()
    if (!rotated) throw new Error('expected account storage')
    rotated.main = {
      type: 'opencode',
      provider: 'anthropic',
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: Date.now() + 10_000,
        accountIdentity: rotated.mainAccountId,
      },
    }
    await saveAccountState(rotated, process.env.OPENCODE_ANTHROPIC_AUTH_FILE, {
      mainProfile: true,
    })
    await Bun.sleep(2)
    resolveProfile(
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

    expect((await loadAccounts())?.main?.profile).toMatchObject({
      tier: 'default_claude_max_20x',
      accountIdentity: rotated.mainAccountId,
    })
  })

  test('delayed boot hydration preserves a live fallback sidebar route', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    let resolveMainProfile!: (response: Response) => void
    let markMainProfileStarted!: () => void
    const mainProfileStarted = new Promise<void>((resolve) => {
      markMainProfileStarted = resolve
    })
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = extractUrl(input)
        const authorization = new Headers(init?.headers).get('authorization')
        if (
          url.includes('/api/oauth/profile') &&
          authorization === 'Bearer main-access'
        ) {
          markMainProfileStarted()
          return new Promise<Response>((resolve) => {
            resolveMainProfile = resolve
          })
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
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await mainProfileStarted

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await waitForSidebarState(
      (state) =>
        state.activeId === 'fallback-1' && state.route === 'fallback-first',
    )
    resolveMainProfile(
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
    let resolveMainProfile!: (response: Response) => void
    let markMainProfileStarted!: () => void
    const mainProfileStarted = new Promise<void>((resolve) => {
      markMainProfileStarted = resolve
    })
    const firstFetchCalls: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        ).get('authorization')
        firstFetchCalls.push(authorization ?? '')
        if (authorization === 'Bearer main-access') {
          markMainProfileStarted()
          return new Promise<Response>((resolve) => {
            resolveMainProfile = resolve
          })
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
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await mainProfileStarted

    const nextTestFetch = mock(() => Promise.resolve(new Response('ok')))
    globalThis.fetch = nextTestFetch as unknown as typeof fetch
    resolveMainProfile(
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

    expect(firstFetchCalls).toEqual([
      'Bearer main-access',
      'Bearer fallback-access',
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
          access: 'main-access',
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
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await expect(
      plugin['command.execute.before']({
        command: 'claude-quota',
        arguments: '',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    expect(profileCalls).toBe(0)
  })

  test('boot hydration publishes storage reloaded after the profile await', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let resolveProfile!: (response: Response) => void
    let markProfileStarted!: () => void
    const profileStarted = new Promise<void>((resolve) => {
      markProfileStarted = resolve
    })
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) {
        markProfileStarted()
        return new Promise<Response>((resolve) => {
          resolveProfile = resolve
        })
      }
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await profileStarted

    const storage = await loadAccounts()
    if (!storage?.quota) throw new Error('expected quota storage')
    const backoff = {
      message: 'Claude quota check failed: 429 — rate limited',
      checkedAt: Date.now(),
      nextRetryAt: Date.now() + 60_000,
      retryCount: 1,
    }
    storage.quota.mainLastQuotaApiError = backoff
    await saveAccountState(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE, {
      mainQuota: true,
    })
    resolveProfile(
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
    expect((await loadAccounts())?.quota?.mainLastQuotaApiError).toEqual(
      backoff,
    )
  })

  test('token rotation reuses the profile for the same account identity', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    const profileCalls: string[] = []
    let liveAccess = 'token-a'
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        if (extractUrl(input).includes('/api/oauth/profile')) {
          const authorization = new Headers(init?.headers).get('authorization')
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
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: liveAccess,
          refresh: `refresh-${liveAccess}`,
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude-account',
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
    liveAccess = 'token-b'
    expect(await showAccounts()).toContain('Team · Max 5x')
    expect(await showAccounts()).toContain('Team · Max 5x')

    expect(profileCalls).toEqual(['Bearer token-a'])
    expect((await loadAccounts())?.main?.profile?.accountIdentity).toBe(
      (await loadAccounts())?.mainAccountId,
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
      globalThis.fetch = mock((input: string | URL | Request) => {
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
      }) as unknown as typeof fetch
      const plugin = await getPlugin(mockClient)
      await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'main-access',
            refresh: 'main-refresh',
            expires: now + PROFILE_TTL_MS * 3,
          }),
        { models: {} },
      )
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
      const showAccounts = async () => {
        await expect(
          plugin['command.execute.before']({
            command: 'claude-account',
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
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    const mockClient = createMockClient()
    let profileCalls = 0
    let liveAccess = 'token-0'
    globalThis.fetch = mock((input: string | URL | Request) => {
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
    }) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: liveAccess,
          refresh: `refresh-${liveAccess}`,
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    const showAccounts = async () => {
      await expect(
        plugin['command.execute.before']({
          command: 'claude-account',
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
    for (let generation = 0; generation < 66; generation++) {
      liveAccess = `token-${generation}`
      await showAccounts()
    }
    liveAccess = 'token-0'
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
    globalThis.fetch = mock((input: string | URL | Request) => {
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
    }) as unknown as typeof fetch
    const plugin = await getPlugin(createMockClient())
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION

    await expect(
      plugin['command.execute.before']({
        command: 'claude-quota',
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
    globalThis.fetch = mock((input: string | URL | Request) =>
      Promise.resolve(
        extractUrl(input).includes('/api/oauth/profile')
          ? new Response('failed', { status: 500 })
          : Response.json({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 20 },
            }),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
          command: 'claude-quota',
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
    globalThis.fetch = mock((input: string | URL | Request) =>
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
    ) as unknown as typeof fetch
    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
        command: 'claude-account',
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
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/api/oauth/profile')) profileCalls++
      return Promise.resolve(new Response('ok'))
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    )

    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined
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
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedHeaders?.get('anthropic-beta')).toContain(
      'fast-mode-2026-02-01',
    )
    expect(JSON.parse(capturedBody!).speed).toBe('fast')
  })

  test('persistent claudeFast setting skips unsupported models', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeFast: { enabled: true },
      }),
    )

    let capturedHeaders: Headers | undefined
    let capturedBody: string | undefined
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
      capturedHeaders = init?.headers
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedHeaders?.get('anthropic-beta')).not.toContain(
      'fast-mode-2026-02-01',
    )
    expect(JSON.parse(capturedBody!).speed).toBeUndefined()
  })

  test('/claude-cache on makes fetch wrapper set ttl on existing cache controls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    let capturedBody: string | undefined
    const mockClient = createMockClient()

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
      capturedBody = init?.body
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    await expect(
      plugin['command.execute.before']({
        command: 'claude-cache',
        arguments: 'on',
        sessionID: 'session-1',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
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
    )
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
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
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
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
    )
    let capturedBody: string | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
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
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'my-access-token',
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
          access: 'access',
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
              access_token: 'background-access-new',
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
          access: 'old-access',
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
        access: 'background-access-new',
        expires: expect.any(Number),
      },
    })
  })

  test('background refresh uses a four-hour minimum window for main oauth', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: true, refreshBeforeExpiryMinutes: 30 },
      }),
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
              access_token: 'early-access-new',
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
          access: 'old-access',
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
        access: 'early-access-new',
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
          access: 'expired',
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
              access_token: 'relogged-main-access',
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
          access: 'relogged-main-access',
          refresh: 'relogged-main-refresh',
          expires: now + 60 * 60_000,
        }),
      { models: {} },
    )
    const preflight = await loadAccounts()
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
    const savedConfig = await loadAccounts()
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
    )
    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/v1/messages'))
        return Promise.resolve(new Response('{}', { status: 200 }))
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'relogged-main-access',
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
    const savedConfig = await loadAccounts()
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
    await useTempAccountFile(
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
            access: 'fallback-access',
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
    )
    const authorizations: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        throw new Error('Quota refresh is already in progress')
      }
      if (url.includes('/v1/oauth/token')) {
        throw new Error('main refresh should not be attempted')
      }
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response('fallback-ok', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: now - 1_000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback-ok')
    expect(authorizations).toEqual(['Bearer fallback-access'])
  })

  test('fetch wrapper refreshes expired token', async () => {
    const fetchCalls: Array<{ url: string; body?: string }> = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      fetchCalls.push({ url, body: init?.body })

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-token',
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

    // Should have called client.auth.set with new tokens
    expect(mockClient.auth.set).toHaveBeenCalled()
  })

  test('fetch wrapper retries transient token refresh failures', async () => {
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
              access_token: 'new-access',
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
          access: 'expired',
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
          access: 'expired',
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
          access: 'expired',
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

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(responseStream, { status: 200 })),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
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

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCount++
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader()
    await fireConcurrentFetches(result)

    // With deduplication, only ONE refresh request should be made, not 5
    expect(tokenRefreshCount).toBe(1)
  })

  test('plugin instances sharing main auth join a refresh while auth persistence is delayed', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    )
    let tokenRefreshCount = 0
    let releaseAuthSet!: () => void
    const authSetBlocked = new Promise<void>((resolve) => {
      releaseAuthSet = resolve
    })
    let authSetStarted!: () => void
    const authSetStartedPromise = new Promise<void>((resolve) => {
      authSetStarted = resolve
    })

    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCount += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const firstClient = createMockClient()
    firstClient.auth.set = mock(async () => {
      authSetStarted()
      await authSetBlocked
    })
    const secondRefreshWait = mock(() => {
      throw new Error('second plugin entered the cross-process refresh wait')
    }) as unknown as typeof setTimeout
    const firstPlugin = await getPlugin(firstClient, '/project-a')
    const secondPlugin = await getPlugin(createMockClient(), '/project-b', {
      setTimeout: secondRefreshWait,
    })
    const expiredAuth = () =>
      Promise.resolve({
        type: 'oauth' as const,
        access: 'expired-token',
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
    await authSetStartedPromise
    const secondFetch = secondResult.fetch(MESSAGES_URL, EMPTY_POST)
    await Bun.sleep(0)
    releaseAuthSet()

    const responses = await Promise.all([firstFetch, secondFetch])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(tokenRefreshCount).toBe(1)
    expect(secondRefreshWait).not.toHaveBeenCalled()
  })

  test('sticky 401 retries with a concurrently rotated main access token', async () => {
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
          mainQuotaToken: tokenFingerprint('old-access'),
        },
      }),
    )
    let currentAuth = {
      type: 'oauth' as const,
      access: 'old-access',
      refresh: 'old-refresh',
      expires: checkedAt + 8 * 60 * 60_000,
    }
    let tokenRefreshCount = 0
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        tokenRefreshCount += 1
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
          }),
        )
      }
      if (url.includes('/v1/messages')) {
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        messageAuthorizations.push(authorization)
        if (authorization === 'Bearer old-access') {
          currentAuth = {
            type: 'oauth',
            access: 'new-access',
            refresh: 'new-refresh',
            expires: checkedAt + 8 * 60 * 60_000,
          }
          return Promise.resolve(new Response('unauthorized', { status: 401 }))
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () => Promise.resolve(currentAuth),
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
      'Bearer old-access',
      'Bearer new-access',
    ])
    expect(tokenRefreshCount).toBe(0)
  })

  test('serves an existing sticky assignment with a live token', async () => {
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
    )
    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      if (extractUrl(input).includes('/v1/messages')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
    expect(authorizations).toEqual(['Bearer main-access', 'Bearer main-access'])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
  })

  test('admits and sends an OAuth route when an empty quota snapshot is fail-open', async () => {
    await useTempAccountFile(
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
    )
    const usageRequests: string[] = []
    const messageAuthorizations: string[] = []
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
    expect(messageAuthorizations).toEqual(['Bearer main-access'])
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
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
    expect(messageAuthorizations).toEqual(['Bearer main-access'])
  })

  test('keeps a sticky main route excluded during identity-agnostic active refresh backoff', async () => {
    const checkedAt = Date.now()
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        routing: { mode: 'sticky-balanced' },
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
          mainLastRefreshError: {
            message: 'refresh unavailable',
            checkedAt,
            nextRetryAt: checkedAt + 60_000,
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
    )
    const messageRequests: string[] = []
    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/v1/messages')) {
        messageRequests.push(extractUrl(input))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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

  test('concurrent refresh with token rotation should not cause cascading failures', async () => {
    const usedRefreshTokens = new Set<string>()

    globalThis.fetch = mock((input: any, init: any) => {
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
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { result } = await setupExpiredTokenLoader()

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
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'new-refresh',
              access_token: 'new-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    const { mockClient, result } = await setupExpiredTokenLoader()
    await fireConcurrentFetches(result)

    // With deduplication, client.auth.set should be called exactly once.
    // Without it, each concurrent refresh calls auth.set independently → 5 calls.
    expect(mockClient.auth.set).toHaveBeenCalledTimes(1)
  })

  test('refresh always reads the latest refresh token, not a stale snapshot', async () => {
    const tokenRequestBodies: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)

      if (url.includes('/v1/oauth/token')) {
        tokenRequestBodies.push(init?.body)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'rotated-refresh',
              access_token: 'fresh-access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response(null, { status: 200 }))
    }) as unknown as typeof fetch

    let callCount = 0
    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)

    const result = await plugin.auth.loader(
      () => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            type: 'oauth',
            access: 'expired-access',
            refresh: 'stale-refresh',
            expires: Date.now() - 1000,
          })
        }
        return Promise.resolve({
          type: 'oauth',
          access: 'expired-access',
          refresh: 'rotated-refresh-from-storage',
          expires: Date.now() - 1000,
        })
      },
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(tokenRequestBodies).toHaveLength(1)
    const sentBody = JSON.parse(tokenRequestBodies[0] ?? '{}')
    expect(sentBody.refresh_token).toBe('rotated-refresh-from-storage')
    expect(sentBody.refresh_token).not.toBe('stale-refresh')
  })

  test('fetch wrapper adds beta=true to /v1/messages URL', async () => {
    let capturedUrl: string | undefined

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'token',
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

    globalThis.fetch = mock((input: any, init: any) => {
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
      if (authHeader === 'Bearer main-access') {
        return Promise.resolve(new Response('limited', { status: 429 }))
      }
      return Promise.resolve(new Response('ok', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(authorizations).toEqual([
      'Bearer main-access',
      'Bearer fallback-access',
    ])
  })

  test('fetch wrapper uses fallback first when routing mode is fallback-first', async () => {
    await useTempAccountFile(
      createFallbackStorage({ routing: { mode: 'fallback-first' } }),
    )
    const authorizations: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
        throw new Error('fallback-first should use cached quota in this test')
      }
      authorizations.push(init?.headers?.get('authorization'))
      return Promise.resolve(new Response('fallback ok', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(authorizations).toEqual(['Bearer fallback-access'])
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
            access: 'unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        return Promise.reject(new Error('quota source unavailable'))
      }
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      authorizations.push(authorization)
      return Promise.resolve(
        new Response(
          authorization === 'Bearer main-access' ? 'limited' : 'ok',
          {
            status: authorization === 'Bearer main-access' ? 429 : 200,
          },
        ),
      )
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(200)
    expect(authorizations).toEqual([
      'Bearer main-access',
      'Bearer unknown-fallback-access',
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
            access: 'unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires,
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        return Promise.reject(new Error('quota source unavailable'))
      }
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      authorizations.push(authorization)
      return Promise.resolve(new Response('fallback ok', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
          refresh: 'main-refresh',
          expires,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(authorizations).toEqual(['Bearer unknown-fallback-access'])
  })

  test('fallback-first rejects an OAuth fallback whose quota is unknown under fail-closed', async () => {
    await expectUnknownQuotaAdmissionBlocked(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'unknown-fallback-access',
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
          mainQuotaToken: tokenFingerprint('main-access'),
        },
      }),
    )
    const usageTokens: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        usageTokens.push(new Headers(init?.headers).get('authorization') ?? '')
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      i < 50 && !usageTokens.includes('Bearer fallback-access');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(usageTokens).toContain('Bearer fallback-access')
  })

  test('fallback-first routing does not refresh expired main oauth when fallback succeeds', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        refresh: { enabled: false },
      }),
    )
    let tokenRefreshCalls = 0
    const authorizations: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'expired-main-access',
          refresh: 'main-refresh',
          expires: Date.now() - 1000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(tokenRefreshCalls).toBe(0)
    expect(authorizations).toEqual(['Bearer fallback-access'])
  })

  test('fallback-first routing tries main when no fallback account is usable', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'fallback-low',
            type: 'oauth',
            access: 'fallback-access',
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
    )
    const authorizations: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('main ok')
    expect(authorizations).toEqual(['Bearer main-access'])
  })

  test('fetch wrapper skips main account when quota policy is already exhausted', async () => {
    await useTempAccountFile(createFallbackStorage())
    const messageAuthorizations: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('fallback ok')
    expect(messageAuthorizations).toEqual(['Bearer fallback-access'])
  })

  test('quota refresh toasts are disabled by default', async () => {
    const storage = createFallbackStorage({ accounts: [] })
    await useTempAccountFile(storage)
    const showToast = mock(() => Promise.resolve())
    const mockClient = {
      ...createMockClient(),
      tui: { showToast },
    }

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient as any)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient as any)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    await useTempAccountFile(createFallbackStorage())
    let quotaCalls = 0
    const messageAuthorizations: string[] = []
    const resetAt = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString()

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST)
    await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(quotaCalls).toBe(1)
    expect(messageAuthorizations).toEqual([
      'Bearer fallback-access',
      'Bearer fallback-access',
    ])
  })

  test('fetch wrapper refreshes stale usable main quota in background', async () => {
    const originalDateNow = Date.now
    let now = 0
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
    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    try {
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'main-access',
            refresh: 'main-refresh',
            expires: 1_000_000,
          }),
        { models: {} },
      )

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'message-1',
      )
      now = 120000
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
      createFallbackStorage({
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 10, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          // Cached, stale, and FAILING five_hour policy (used 95% → remaining 5% < 10%).
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
          // Bind the cached main quota to the access token the loader will use.
          mainQuotaToken: tokenFingerprint('main-access'),
        } as AccountStorage['quota'],
      }),
    )

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    globalThis.fetch = mock((input: any, init: any) => {
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
      if (authHeader === 'Bearer main-access') {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('message_stop')
    expect(authorizations).toEqual([
      'Bearer main-access',
      'Bearer fallback-access',
    ])
  })

  test('fetch wrapper returns inspected streaming rate limit response when fallbacks are unavailable', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'fallback-low',
            type: 'oauth',
            access: 'fallback-access',
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
    )
    const authorizations: string[] = []

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('rate_limit_error')
    expect(authorizations).toEqual(['Bearer main-access'])
  })

  test('fetch wrapper does not use fallback accounts below quota thresholds', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'fallback-low',
            type: 'oauth',
            access: 'fallback-access',
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
    )
    let calls = 0

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    await useTempAccountFile(createFallbackStorage())
    let calls = 0
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'))
        controller.close()
      },
    })

    globalThis.fetch = mock(() => {
      calls += 1
      return Promise.resolve(new Response('limited', { status: 429 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      createFallbackStorage({
        routing: { mode: 'sticky-balanced' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(0),
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        accounts: [
          {
            id: 'yiyi',
            type: 'oauth',
            access: 'scarce-access',
            refresh: 'scarce-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(13),
          },
          {
            id: 'ufuk2',
            type: 'oauth',
            access: 'abundant-access',
            refresh: 'abundant-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(98),
          },
        ],
      }),
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
      if (rejectMain && authorization === 'Bearer main-access') {
        return Promise.resolve(new Response('forbidden', { status: 403 }))
      }
      if (refusal) {
        refusal = false
        return Promise.resolve(new Response(refusalSse, { status: 200 }))
      }
      return Promise.resolve(new Response(successSse, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin(createMockClient())
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      'Bearer abundant-access',
      'Bearer abundant-access',
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
    expect(authorizations.at(-1)).toBe('Bearer main-access')

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
      'Bearer main-access',
      'Bearer scarce-access',
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
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth',
            access: 'fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'fallback-b-access',
            refresh: 'fallback-b-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
        ],
      }),
    )
    let messageRequests = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      if (extractUrl(input).includes('/v1/messages')) messageRequests += 1
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    let currentAuth = {
      type: 'oauth' as const,
      access: 'main-access',
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

    currentAuth = {
      type: 'oauth',
      access: 'main-access',
      refresh: 'relogged-main-refresh',
      expires: checkedAt + 5 * 60 * 60_000,
    }
    const recovered = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_sticky_no_fable_route' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        stream: true,
        messages: [{ role: 'user', content: 'after re-login' }],
      }),
    })

    expect(recovered.status).toBe(401)
    expect(messageRequests).toBe(0)
    const savedState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(savedState.main?.lastRefreshError).toBeDefined()
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
      createFallbackStorage({
        routing: { mode: 'sticky-balanced' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(0),
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        accounts: [
          {
            id: 'oauth-fallback',
            type: 'oauth',
            access: 'fallback-access',
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
    )

    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
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
        authorization === 'Bearer fallback-access'
          ? new Response('exhausted', { status: 429 })
          : new Response('ok', { status: 200 }),
      )
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    expect(authorizations).toEqual(['Bearer fallback-access', 'Bearer api-key'])
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
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        accounts: [
          {
            id: 'ufuk2',
            type: 'oauth',
            access: 'abundant-access',
            refresh: 'abundant-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(98),
          },
        ],
      }),
    )
    const authorizations: string[] = []
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(new Response('ok', { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    const storage = await loadAccounts(process.env.OPENCODE_ANTHROPIC_AUTH_FILE)
    if (!storage) throw new Error('missing test storage')
    storage.routing = { mode: 'sticky-balanced' }
    await saveAccounts(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE)
    await (await result.fetch(MESSAGES_URL, request)).text()

    expect(authorizations).toEqual(['Bearer main-access', 'Bearer main-access'])
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
      createFallbackStorage({
        routing: { mode: 'sticky-balanced' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(0),
          mainQuotaCheckedAt: checkedAt,
          mainQuotaToken: tokenFingerprint('main-access'),
        },
        accounts: [
          {
            id: 'yiyi',
            type: 'oauth',
            access: 'scarce-access',
            refresh: 'scarce-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(13),
          },
          {
            id: 'ufuk2',
            type: 'oauth',
            access: 'abundant-access',
            refresh: 'abundant-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(98),
          },
        ],
      }),
    )
    const authorizations: string[] = []
    let modelRequest = 0
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        const authorization = new Headers(init?.headers).get('authorization')
        const abundant = authorization === 'Bearer abundant-access'
        const main = authorization === 'Bearer main-access'
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
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
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
    }) as unknown as typeof fetch

    Date.now = mock(() => now) as unknown as typeof Date.now
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      'Bearer abundant-access',
      'Bearer abundant-access',
      'Bearer scarce-access',
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
      (input: string | URL | Request, init?: RequestInit) => {
        if (!extractUrl(input).includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        sentBody = JSON.parse(String(init?.body))
        return Promise.resolve(new Response(fallbackSse, { status: 200 }))
      },
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

  test('uses Anthropic server-side fallback by default and reports fallback and restoration transitions', async () => {
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
              model: 'claude-fable-5',
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
        message: { id: 'msg_restored', model: 'claude-fable-5' },
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
              model: 'claude-fable-5',
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')

    globalThis.fetch = mock(
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
    ])
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_server_fallback' },
      body: JSON.stringify({
        model: 'claude-fable-5',
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
      requestedModelId: 'claude-fable-5',
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
      'claude-fable-5',
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
              text: expect.stringContaining('Returning to Fable 5'),
            }),
          ],
        }),
      }),
    )
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

    globalThis.fetch = mock((input: any, init: any) => {
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
    }) as unknown as typeof fetch

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
          access: 'main-access',
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

    // A later authoritative idle signal retries the still-queued notice.
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (body.max_tokens === 0) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      models.push(String(body.model))
      return Promise.resolve(new Response(fallbackSse, { status: 200 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
          mainQuotaToken: tokenFingerprint('main-access'),
        } as AccountStorage['quota'],
        accounts: [
          {
            id: 'fable-fallback',
            type: 'oauth',
            access: 'fallback-access',
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
          access: 'main-access',
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
        auth: 'Bearer fallback-access',
        warm: false,
      },
      { model: 'claude-opus-4-8', auth: 'Bearer main-access', warm: false },
      {
        model: 'claude-fable-5',
        auth: 'Bearer fallback-access',
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
            access: 'fallback-access',
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

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    // Running the loader starts the background refresh (immediate first pass).
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      getAccessToken: () => string = () => 'main-access',
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

    async function waitForState(predicate: (state: any) => boolean) {
      let lastState: unknown
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const state = JSON.parse(
            await readFile(
              getAccountStatePath(process.env.OPENCODE_ANTHROPIC_AUTH_FILE),
              'utf8',
            ),
          )
          lastState = state
          if (predicate(state)) return state
        } catch {}
        await Bun.sleep(10)
      }
      throw new Error(
        `quota state did not persist: ${JSON.stringify(lastState)}`,
      )
    }

    test('main 200 response pushes unified headers before returning the response', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('main-ok', { headers: quotaHeaders })),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(await response.text()).toBe('main-ok')
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      expect(state.main.quotaToken).toBeUndefined()
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
      globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization')
        authorizations.push(authorization)
        return Promise.resolve(
          new Response('ok', {
            headers:
              authorization === 'Bearer main-access'
                ? {
                    ...quotaHeaders,
                    'anthropic-ratelimit-unified-5h-utilization': '1',
                  }
                : undefined,
          }),
        )
      }) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(authorizations).toEqual(['Bearer main-access', 'Bearer kie-key'])
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
            mainQuotaToken: tokenFingerprint('main-access'),
          },
        }),
      )
      const authorizations: Array<string | null> = []
      globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('authorization'))
        return Promise.resolve(new Response('ok'))
      }) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)

      expect(authorizations).toEqual(['Bearer main-access'])
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
      expect(state.main.quotaToken).toBeUndefined()
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
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url === 'https://relay.example.test') {
          return Promise.resolve(
            new Response('relay unavailable', { status: 503 }),
          )
        }
        return Promise.resolve(
          new Response('direct', { headers: quotaHeaders }),
        )
      }) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      try {
        const response = await result.fetch(MESSAGES_URL, {
          ...EMPTY_POST,
          headers: { 'x-session-affinity': 'quota-relay-direct-fallback' },
        })
        expect(await response.text()).toBe('direct')
        await waitForState((value) => value.main?.quota?.source === 'headers')
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
      expect((await loadAccounts())?.quota?.mainQuota?.source).toBeUndefined()
    })

    test('main header push persists after access-token rotation for the same account', async () => {
      let liveAccessToken = 'old-main-access'
      const existingQuota = {
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 1,
        },
        source: 'poll' as const,
        checkedAt: 1,
      }
      await useTempAccountFile(
        createFallbackStorage({
          mainAccountId: 'account-x',
          accounts: [],
          quota: {
            enabled: false,
            mainQuota: existingQuota,
            mainQuotaCheckedAt: 1,
          },
        }),
      )
      let resolveResponse: ((response: Response) => void) | undefined
      let markRequestStarted: (() => void) | undefined
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve
      })
      const requestAuthorizations: Array<string | null> = []
      globalThis.fetch = mock(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            requestAuthorizations.push(
              new Headers(init?.headers).get('authorization'),
            )
            resolveResponse = resolve
            markRequestStarted?.()
          }),
      ) as unknown as typeof fetch
      const result = await loadFetch(() => liveAccessToken)
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      setLogLevel('debug')

      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      await requestStarted
      liveAccessToken = 'new-main-access'
      resolveResponse?.(new Response('main-ok', { headers: quotaHeaders }))
      await responsePromise
      await Bun.sleep(100)
      const rawState = JSON.parse(
        await readFile(
          getAccountStatePath(process.env.OPENCODE_ANTHROPIC_AUTH_FILE),
          'utf8',
        ),
      )
      const reloaded = await loadAccounts()

      expect(
        records.some(
          (record) =>
            record.channel === 'quota' &&
            record.message === 'harvested response quota',
        ),
      ).toBe(true)
      expect(requestAuthorizations[0]).toBe('Bearer old-main-access')
      expect(rawState.main.quota.five_hour.usedPercent).toBe(78)
      expect(rawState.main.quota.accountIdentity).toBe('account-x')
      expect(rawState.main.quotaToken).toBeUndefined()
      expect(reloaded?.quota?.mainQuota?.five_hour?.usedPercent).toBe(78)
      expect(reloaded?.quota?.mainQuota?.accountIdentity).toBe('account-x')
      expect(reloaded?.quota?.mainQuotaToken).toBeUndefined()
      __setLogTestSink(null)
      setLogLevel('info')
    })

    test('fallback header push persists after access-token rotation for the same account', async () => {
      const fallbackTemplate = createFallbackStorage()
        .accounts[0] as OAuthAccount
      const existingQuota = fallbackTemplate.quota
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [
            {
              ...fallbackTemplate,
              access: 'old-fallback-access',
              quota: existingQuota,
            },
          ],
          quota: { enabled: false },
        }),
      )
      let messageCalls = 0
      let resolveFallbackResponse: ((response: Response) => void) | undefined
      let fallbackRequestStarted: (() => void) | undefined
      const fallbackStarted = new Promise<void>((resolve) => {
        fallbackRequestStarted = resolve
      })
      globalThis.fetch = mock((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response('usage-unavailable', { status: 500 }),
          )
        }
        messageCalls++
        if (messageCalls === 1)
          return Promise.resolve(new Response('limited', { status: 429 }))
        return new Promise<Response>((resolve) => {
          resolveFallbackResponse = resolve
          fallbackRequestStarted?.()
        })
      }) as unknown as typeof fetch
      const result = await loadFetch()
      const responsePromise = result.fetch(MESSAGES_URL, EMPTY_POST)
      await fallbackStarted

      const rotated = await loadAccounts()
      if (!rotated) throw new Error('expected rotated fallback storage')
      const fallback = rotated.accounts.find(
        (account): account is OAuthAccount => account.id === 'fallback-1',
      )
      if (!fallback) throw new Error('expected fallback account')
      fallback.access = 'new-fallback-access'
      await saveAccounts(rotated)
      resolveFallbackResponse?.(
        new Response('fallback-ok', { headers: quotaHeaders }),
      )
      await responsePromise

      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      expect(state.accounts['fallback-1'].quota.accountIdentity).toBe(
        'fallback-1',
      )
      expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(78)
    })

    test('fallback header push does not persist onto a different account identity', async () => {
      const accountXQuota = {
        five_hour: {
          usedPercent: 11,
          remainingPercent: 89,
          checkedAt: 1,
        },
      }
      const servedAccount = {
        ...(createFallbackStorage().accounts[0] as OAuthAccount),
        access: 'served-account-access',
        quota: accountXQuota,
      }
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [
            {
              ...(createFallbackStorage().accounts[0] as OAuthAccount),
              id: 'account-x',
              lastRefreshError: {
                message: 'dead fallback',
                checkedAt: Date.now(),
                permanent: true,
                accountIdentity: 'account-x',
              },
              quota: accountXQuota,
            },
            servedAccount,
          ],
          quota: { enabled: false },
        }),
      )
      let messageCalls = 0
      globalThis.fetch = mock((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response('usage-unavailable', { status: 500 }),
          )
        }
        messageCalls++
        return Promise.resolve(
          messageCalls === 1
            ? new Response('limited', { status: 429 })
            : new Response('fallback-ok', { headers: quotaHeaders }),
        )
      }) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      expect(state.accounts['account-x'].quota).toEqual(accountXQuota)
      expect(state.accounts['fallback-1'].quota.accountIdentity).toBe(
        'fallback-1',
      )
    })

    test('main header push preserves persisted poll backoff across reload', async () => {
      const pollBackoff = {
        message: 'Claude quota check failed: 429 — rate limited',
        checkedAt: Date.now(),
        nextRetryAt: Date.now() + 60_000,
        retryCount: 1,
      }
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: false,
            mainLastQuotaApiError: pollBackoff,
          },
        }),
      )
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('main-ok', { headers: quotaHeaders })),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'main-ok',
      )
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )
      const reloaded = await loadAccounts()

      expect(state.main.lastQuotaApiError).toEqual(pollBackoff)
      expect(state.main.quota.five_hour.usedPercent).toBe(78)
      expect(reloaded?.quota?.mainLastQuotaApiError).toEqual(pollBackoff)
      expect(reloaded?.quota?.mainQuota?.source).toBe('headers')
    })

    test('primary adapter harvests one response frame and makes no corroborating usage request', async () => {
      await useTempAccountFile(harvestStorage())
      let messageCalls = 0
      let usageCalls = 0
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      globalThis.fetch = mock((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) usageCalls++
        if (url.includes('/v1/messages')) messageCalls++
        return Promise.resolve(new Response('ok', { headers: quotaHeaders }))
      }) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      const state = await waitForState(
        (value) => value.main?.quota?.source === 'headers',
      )

      expect(messageCalls).toBe(1)
      expect(usageCalls).toBe(0)
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
      globalThis.fetch = mock((input: string | URL | Request) => {
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
      }) as unknown as typeof fetch
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
        harvestStorage([{ ...fallback, lastQuotaRefreshError: pollBackoff }]),
      )
      let messages = 0
      globalThis.fetch = mock((input: string | URL | Request) => {
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
      }) as unknown as typeof fetch
      const result = await loadFetch()

      expect(await (await result.fetch(MESSAGES_URL, EMPTY_POST)).text()).toBe(
        'fallback-ok',
      )
      const state = await waitForState(
        (value) => value.accounts?.['fallback-1']?.quota?.source === 'headers',
      )
      const reloaded = await loadAccounts()
      const reloadedFallback = reloaded?.accounts.find(
        (account): account is OAuthAccount =>
          account.id === 'fallback-1' && account.type === 'oauth',
      )

      expect(state.accounts['fallback-1'].lastQuotaRefreshError).toEqual(
        pollBackoff,
      )
      expect(state.accounts['fallback-1'].quota.five_hour.usedPercent).toBe(78)
      expect(reloadedFallback?.lastQuotaRefreshError).toEqual(pollBackoff)
      expect(reloadedFallback?.quota?.source).toBe('headers')
    })

    test('sidebar state reflects header-pushed freshness and served fallback attribution', async () => {
      await useTempAccountFile(harvestStorage(createFallbackStorage().accounts))
      let messages = 0
      globalThis.fetch = mock((input: string | URL | Request) => {
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
      }) as unknown as typeof fetch
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
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('ok')),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await Bun.sleep(30)

      expect((await loadAccounts())?.quota?.mainQuota?.source).toBeUndefined()
    })

    test('non-finite utilization headers leave stored quota untouched', async () => {
      const existingQuota = {
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
        createFallbackStorage({
          accounts: [],
          quota: {
            enabled: false,
            mainQuota: existingQuota,
            mainQuotaCheckedAt: 1,
            mainQuotaToken: tokenFingerprint('main-access'),
          },
        }),
      )
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('ok', {
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': 'garbage',
              'anthropic-ratelimit-unified-7d-utilization': 'NaN',
            },
          }),
        ),
      ) as unknown as typeof fetch
      const result = await loadFetch()

      await result.fetch(MESSAGES_URL, EMPTY_POST)
      await Bun.sleep(30)

      expect((await loadAccounts())?.quota?.mainQuota).toEqual(existingQuota)
    })

    test('malformed quota headers never reject or replace the original response', async () => {
      await useTempAccountFile(harvestStorage())
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('original', {
            status: 202,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.5',
              'anthropic-ratelimit-unified-5h-reset': '1e308',
            },
          }),
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
      globalThis.fetch = mock((input: string | URL | Request) => {
        if (extractUrl(input).includes('/api/oauth/usage')) usageCalls++
        return Promise.resolve(new Response('ok', { headers: quotaHeaders }))
      }) as unknown as typeof fetch
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
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('ok', { headers: quotaHeaders })),
      ) as unknown as typeof fetch
      const result = await loadFetch()
      setLogLevel('debug')

      await result.fetch(MESSAGES_URL, EMPTY_POST)

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
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('ok', {
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.5',
              'anthropic-ratelimit-unified-5h-reset': '1e308',
            },
          }),
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
    pluginTimerOverrides = {
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
    pluginTimerOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true })
      tempConfigDir = undefined
    }
  })

  test('claude-start request shapes only its correlated OAuth turn and emits diagnostics', async () => {
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
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
    }) as unknown as typeof fetch
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
          access: 'main-access',
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
        command: 'claude-cachekeep',
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
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      sent.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      })
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
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
          access: 'main-access',
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
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
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
            access: 'main-access',
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
      globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        sent.push({ body: JSON.parse(String(init?.body)), headers })
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers:
              headers.get('authorization') === 'Bearer main-access'
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
      }) as unknown as typeof fetch
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'main-access',
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
            access: 'fallback-access',
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
          mainQuotaToken: tokenFingerprint('main-access'),
        },
      }),
    )
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
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
            headers.get('authorization') === 'Bearer main-access'
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
    }) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'main-access',
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
        entry.headers.get('authorization') === 'Bearer fallback-access',
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
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      seenHeaders.push(new Headers(init?.headers))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
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
          access: 'main-access',
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
      access: 'main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100_000,
    })

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    pluginTimerOverrides = {
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
    pluginTimerOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true })
      tempConfigDir = undefined
    }
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
    globalThis.fetch = mock((_input: any, init: RequestInit) => {
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
    }) as unknown as typeof fetch
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
    globalThis.fetch = mock((_input: any, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)))
      sentHeaders.push(new Headers(init.headers))
      requestNumber++
      return Promise.resolve(sseResponse(message(`provider-${requestNumber}`)))
    }) as unknown as typeof fetch
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
    globalThis.fetch = mock((_input: any, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)))
      betaHeaders.push(new Headers(init.headers).get('anthropic-beta') ?? '')
      return Promise.resolve(
        sseResponse(message(`provider-${sentBodies.length}`)),
      )
    }) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient)
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    await expect(
      plugin['command.execute.before']({
        command: 'claude-logging',
        arguments: 'debug',
        sessionID: 'session-cache-diagnostics',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
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
    globalThis.fetch = mock((_input: any, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)))
      const id = sentBodies.length === 1 ? 'provider-json-A' : 'provider-json-B'
      return Promise.resolve(
        new Response(JSON.stringify(message(id)), { status: 200 }),
      )
    }) as unknown as typeof fetch
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
    pluginTimerOverrides = {
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
    globalThis.fetch = mock((_input: any, init: RequestInit) => {
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
          message(normalRequests === 1 ? 'provider-real-A' : 'provider-real-C'),
        ),
      )
    }) as unknown as typeof fetch
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
    globalThis.fetch = mock(() => {
      const response = responses.shift()
      if (!response) throw new Error('unexpected request')
      return Promise.resolve(sseResponse(response))
    }) as unknown as typeof fetch
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
        createFallbackStorage({
          dump: { enabled: true },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: { usedPercent: 100, remainingPercent: 0 },
              seven_day: { usedPercent: 50, remainingPercent: 50 },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('main-access'),
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
      )
      const records: LogTestRecord[] = []
      let sentBody: Record<string, unknown> | undefined
      let sentBeta = ''
      globalThis.fetch = mock((_input: any, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body))
        sentBeta = new Headers(init.headers).get('anthropic-beta') ?? ''
        return Promise.resolve(sseResponse(message('provider-api')))
      }) as unknown as typeof fetch
      __setLogTestSink((record) => records.push(record))

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      await (
        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': 'ses-api' },
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        })
      ).text()

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
      globalThis.fetch = mock(() => {
        const response = responses.shift()
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(response)
      }) as unknown as typeof fetch

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
    globalThis.fetch = originalFetch
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    // Prevent this plugin instance's background intervals from leaking into
    // later tests without mutating process-global timers used by other files.
    pluginTimerOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    pluginTimerOverrides = {}
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  })

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'main-access',
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

    globalThis.fetch = mock((input: any) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
        return Promise.resolve(
          new Response(
            // five_hour remaining 8% (< routing 10, > killswitch 5),
            // seven_day remaining 60% (above both).
            JSON.stringify({
              five_hour: { utilization: 92 },
              seven_day: { utilization: 40 },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response('message-ok', { status: 200 }))
    }) as unknown as typeof fetch

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

    globalThis.fetch = mock((input: any, init: any) => {
      if (extractUrl(input).includes('/api/oauth/usage')) {
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        // main killed (remaining 2%), fallback healthy (remaining 90%).
        const utilization = authorization.includes('main-access') ? 98 : 10
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
    }) as unknown as typeof fetch

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
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let mainServed = false
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        // main killed (5h remaining 2%). fallback 5h remaining 7% — above the
        // killswitch threshold (5) but below the routing minimumRemaining (10).
        const fiveHourUtil = authorization.includes('main-access') ? 98 : 93
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
    }) as unknown as typeof fetch

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
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let servedAuth: string | undefined
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        const isMain = authorization.includes('main-access')
        // main healthy (80%); fallback at 30% — below killswitch (50), above
        // routing minimumRemaining (10).
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const response = await result.fetch(MESSAGES_URL, EMPTY_POST)

    expect(response.status).toBe(200)
    expect(servedAuth).toContain('main-access')
    expect(servedAuth).not.toContain('fallback-access')
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
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        // Quota API down → eager refresh fails → main quota stays unknown.
        return Promise.resolve(new Response('upstream error', { status: 500 }))
      }
      mainServed = true
      return Promise.resolve(new Response('message-ok', { status: 200 }))
    }) as unknown as typeof fetch

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
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      if (url.includes('/api/oauth/usage')) {
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        const isMain = authorization.includes('main-access')
        // main 5h 30% (passes routing 10, fails killswitch 50 → killed);
        // fallback 5h 90% (passes both). 7d healthy for both.
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
    }) as unknown as typeof fetch

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
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: Date.now() + 5 * 60 * 60 * 1000,
          },
        ],
      }),
    )

    let mainServed = false
    globalThis.fetch = mock((input: any, init: any) => {
      const url = extractUrl(input)
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      if (url.includes('/api/oauth/usage')) {
        const isMain = authorization.includes('main-access')
        // main 30% (passes routing 10, fails killswitch 50 → killed);
        // fallback 90% (a survivor).
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
      if (authorization.includes('main-access')) {
        mainServed = true
        return Promise.resolve(new Response('main-ok', { status: 200 }))
      }
      // Surviving fallback is rate-limited at request time.
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'fallback-limited' }), {
          status: 429,
        }),
      )
    }) as unknown as typeof fetch

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
  const originalSetInterval = globalThis.setInterval

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalSetInterval
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
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      { identity: getClaudeCodeIdentity('main-access') },
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
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    expect(observedAuth).toContain('main-access')
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
    )

    let sends = 0
    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const firstPlugin = await getPlugin()
    await firstPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access-a',
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
    const firstState = JSON.parse(
      await readFile(getAccountStatePath(), 'utf8'),
    ) as { main?: { primeAuthLineageId?: string } }
    const firstLineage = firstState.main?.primeAuthLineageId

    const secondPlugin = await getPlugin()
    await secondPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access-b',
          refresh: 'main-refresh-b',
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
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8')) as {
      main?: { primeAuthLineageId?: string }
    }
    expect(firstLineage).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.main?.primeAuthLineageId).toBe(firstLineage)
  })

  test('main refresh through the plugin keeps the lineage and prime claim', async () => {
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

    const intervalHandlers: Array<() => void> = []
    globalThis.setInterval = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    let hostAuth = {
      type: 'oauth',
      access: 'main-access-a',
      refresh: 'main-refresh-a',
      expires: Date.now() + 5 * 60 * 60_000,
    }
    const mockClient = createMockClient()
    let lineageObservedBeforePublish: string | undefined
    let lineageObservedDuringPublish: string | undefined
    ;(mockClient.auth as any).set = mock(
      async (input: {
        body: {
          type: string
          access: string
          refresh: string
          expires: number
        }
      }) => {
        lineageObservedBeforePublish = await getOrCreatePrimeAuthLineageId(
          'main',
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
        )
        hostAuth = { ...input.body }
        lineageObservedDuringPublish = await getOrCreatePrimeAuthLineageId(
          'main',
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
        )
      },
    )
    let sends = 0
    globalThis.fetch = mock((input: any) => {
      const url = extractUrl(input)
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'main-refresh-b',
              access_token: 'main-access-b',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
    await plugin.auth.loader(() => Promise.resolve(hostAuth), { models: {} })
    const manager = (plugin as any).__primeManager
    await manager.tick()
    const before = JSON.parse(
      await readFile(getAccountStatePath(), 'utf8'),
    ) as {
      main?: {
        primeAuthLineageId?: string
        primeAuthLineageRefreshTokenFingerprint?: string
      }
    }

    hostAuth.expires = Date.now() - 1
    const mainRefreshHandler = intervalHandlers.at(-1)
    expect(mainRefreshHandler).toBeDefined()
    mainRefreshHandler!()
    await waitForMockCall(mockClient.auth.set)
    await manager.tick()

    const after = JSON.parse(
      await readFile(getAccountStatePath(), 'utf8'),
    ) as typeof before
    expect(sends).toBe(1)
    expect(lineageObservedBeforePublish).toBe(before.main?.primeAuthLineageId)
    expect(lineageObservedDuringPublish).toBe(before.main?.primeAuthLineageId)
    expect(after.main?.primeAuthLineageId).toBe(before.main?.primeAuthLineageId)
    expect(after.main?.primeAuthLineageRefreshTokenFingerprint).toBeUndefined()
  })

  test('a main refresh lease adopter preserves the legacy lineage binding', async () => {
    const lineage = 'main-lineage-a'
    const refreshToken = 'main-refresh-a'
    const storage = createFallbackStorage({
      accounts: [],
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
        mainAuthLineageRefreshTokenFingerprint: tokenFingerprint(refreshToken),
      },
    })
    await useTempAccountFile(storage)
    await saveAccountState(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE, {
      mainRefresh: true,
      mainPrime: true,
    })

    let hostAuth = {
      type: 'oauth',
      access: 'main-access-a',
      refresh: refreshToken,
      expires: Date.now() + 5 * 60 * 60_000,
    }
    let observedAuthorization: string | null = null
    globalThis.fetch = mock((_input: any, init?: RequestInit) => {
      observedAuthorization = new Headers(init?.headers).get('authorization')
      return Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(() => Promise.resolve(hostAuth), {
      models: {},
    })
    hostAuth.expires = Date.now() - 1
    const request = result.fetch(MESSAGES_URL, EMPTY_POST)
    await Bun.sleep(25)
    hostAuth = {
      type: 'oauth',
      access: 'main-access-b',
      refresh: 'main-refresh-b',
      expires: Date.now() + 60 * 60_000,
    }
    const response = await request

    expect(response.status).toBe(200)
    expect(String(observedAuthorization)).toContain('main-access-b')
    const state = JSON.parse(await readFile(getAccountStatePath(), 'utf8')) as {
      main?: {
        primeAuthLineageId?: string
        primeAuthLineageRefreshTokenFingerprint?: string
      }
    }
    expect(state.main?.primeAuthLineageId).toBe(lineage)
    expect(state.main?.primeAuthLineageRefreshTokenFingerprint).toBe(
      tokenFingerprint(refreshToken),
    )
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
            access: 'fb-access',
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
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
        c.url === `${MESSAGES_URL}?beta=true` && c.auth?.includes('fb-access'),
    )
    expect(primeCall).toBeDefined()
    expect(primeCall?.auth).toContain('fb-access')
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
            access: 'fb-access-a',
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
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
    const rotated = await loadAccounts()
    const account = rotated!.accounts.find(
      (candidate) => candidate.id === 'work-rotating',
    )!
    if (account.type !== 'oauth') throw new Error('expected OAuth account')
    account.access = 'fb-access-b'
    account.refresh = 'fb-refresh-b'
    await saveAccounts(rotated!)
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
    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    // No counter incremented (state file has no main.prime)
    const statePath = getAccountStatePath(
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
    )
    const raw = JSON.parse(await readFile(statePath, 'utf8'))
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

    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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

    const statePath = getAccountStatePath(
      process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
    )
    const raw = JSON.parse(await readFile(statePath, 'utf8'))
    expect(raw.main.prime).toEqual({
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
    )

    let authCallCount = 0
    const primeCalls: Array<{ url: string; init: RequestInit | undefined }> = []
    let _quotaCalls = 0
    globalThis.fetch = mock((input: any, init?: RequestInit) => {
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
              access_token: 'refreshed-main-access',
              refresh_token: 'main-refresh',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(new Response('not-mocked', { status: 599 }))
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    // First call: getAuth returns oauth WITHOUT access (triggers refresh).
    // Second call: getAuth returns oauth WITH the refreshed access token.
    await plugin.auth.loader(
      () => {
        authCallCount += 1
        if (authCallCount === 1) {
          return Promise.resolve({
            type: 'oauth',
            access: undefined,
            refresh: 'main-refresh',
            expires: undefined,
          })
        }
        return Promise.resolve({
          type: 'oauth',
          access: 'refreshed-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        })
      },
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
    expect(headers.get('authorization')).toContain('refreshed-main-access')
  })

  test('plugin instances with the same storage path adopt one prime manager', async () => {
    const fixture = createFallbackStorage({
      prime: { enabled: true },
    })
    await useTempAccountFile(fixture)
    let intervalCalls = 0
    ;(globalThis as any).setInterval = mock(() => {
      intervalCalls += 1
      return { unref() {} } as unknown as ReturnType<typeof setInterval>
    })
    const plugin1 = await getPlugin()
    const mgr1 = (plugin1 as any).__primeManager
    const firstLoadStorage = mgr1.options.loadStorage
    expect(mgr1).toBeDefined()
    expect(mgr1.isStopped?.()).toBeFalsy()
    const intervalsAfterFirstPlugin = intervalCalls
    const plugin2 = await getPlugin()
    const mgr2 = (plugin2 as any).__primeManager
    expect(mgr2).toBeDefined()
    expect(mgr2).toBe(mgr1)
    expect(mgr2.options.loadStorage).not.toBe(firstLoadStorage)
    expect(mgr1.isStopped()).toBe(false)
    expect(intervalCalls - intervalsAfterFirstPlugin).toBe(1)
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
    ;(globalThis as any).setInterval = mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    )
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    // Baseline: prime disabled in storage → no prime section in sidebar.
    const before = await readSidebar()
    expect(before.prime).toBeUndefined()

    await expect(
      plugin['command.execute.before']({
        command: 'claude-prime',
        arguments: 'on',
        sessionID: 'ses_test',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

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
    ;(globalThis as any).setInterval = mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    )
    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    // Prime a baseline sidebar write by issuing `/claude-prime on` (the
    // mutation path publishes the sidebar section per M7).
    await expect(
      plugin['command.execute.before']({
        command: 'claude-prime',
        arguments: 'on',
        sessionID: 'ses_test',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const baseline = await readSidebar()
    expect(baseline.prime?.enabled).toBe(true)

    await expect(
      plugin['command.execute.before']({
        command: 'claude-prime',
        arguments: 'off',
        sessionID: 'ses_test',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')

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
  const originalSetInterval = globalThis.setInterval

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalSetInterval
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
          access: 'main-access',
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
          access: 'main-access',
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
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'fb-access',
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
                // Recent (1min) so the background refresh's
                // `isFallbackStale` guard does NOT fire a competing
                // refresh in the same millisecond — without this the
                // prime fresh-check's baseline equals the fetched
                // checkedAt and `fresh` is false.
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
          mainQuotaToken: 'main-access',
        },
        prime: { enabled: true },
      }),
    )

    let usageCalls = 0
    let primeCalls = 0
    globalThis.fetch = mock((input: any) => {
      const url = typeof input === 'string' ? input : input.url
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
            access: 'fb-access',
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
          mainQuotaToken: 'main-access',
        },
        prime: { enabled: true },
      }),
    )

    let primeCalls = 0
    globalThis.fetch = mock((input: any) => {
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
    }) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
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
      quotaManager.refreshFallback('work-alt', 'fb-access', undefined),
    ).rejects.toThrow('429')

    const mgr = (plugin as any).__primeManager
    await mgr.tick()

    expect(primeCalls).toBe(0)
  })
})

describe('claude-prime — warn dedup (R3)', () => {
  // R3: on a fresh-check-ok-but-fire-time-token-refresh-fails path,
  // both the adapter-side `prime fire failed` warn (index.ts main
  // catch) and the manager-side warn emit the same message. Only the
  // manager should log — the adapter must surface the error to the
  // manager as a non-ok result and not log itself.

  const originalFetch = globalThis.fetch
  const originalSetInterval = globalThis.setInterval

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval
    // Marker dir is shared across processes; sweep leftovers so a prior
    // suite's fire doesn't suppress the next suite's claim.
    await rm(join(tmpdir(), 'opencode-anthropic-auth', 'prime'), {
      recursive: true,
      force: true,
    }).catch(() => {})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalSetInterval
  })

  test('R3: a fire-time main token refresh failure produces exactly one warn·prime·prime token refresh failed record (distinct from the generic fire-failed event)', async () => {
    // Force a genuine token-refresh failure during the fire path. The
    // getAuth returns no access token + a past expiry, so
    // `getCurrentMainAccessToken` invokes `latestRefreshMainAccessToken`,
    // which is mocked to throw. This is the ONLY way to exercise the
    // `prime token refresh failed` event from the main path.
    const records: any[] = []
    globalThis.fetch = mock((input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/v1/messages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      if (url.includes('/api/oauth/usage')) {
        return freshPrimeQuotaResponse({
          five_hour: {
            utilization: 0,
            resets_at: new Date(Date.now() - 1_000).toISOString(),
            checked_at: Date.now(),
          },
        })
      }
      return Promise.resolve(new Response('not-mocked', { status: 599 }))
    }) as unknown as typeof fetch

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
              resetsAt: new Date(Date.now() - 180_000).toISOString(),
              checkedAt: 1,
            },
          },
          mainQuotaCheckedAt: 1,
          mainQuotaToken: 'fp-main',
        },
        prime: { enabled: true },
      }),
    )

    const plugin = await getPlugin()
    // The init loader calls getAuth once (call 1). Prime lineage
    // reconciliation observes the refresh token (call 2), then the fresh-check
    // calls getAuth (call 3) — return a valid token. The fire path calls getAuth
    // (call 4) — return a no-access / past-expiry auth so the refresh path is
    // exercised. The refresh function
    // fetches the token endpoint which the mock returns 599 for —
    // this is the genuine token-refresh failure.
    let authCallCount = 0
    await plugin.auth.loader(
      () => {
        authCallCount += 1
        if (authCallCount <= 2) {
          return Promise.resolve({
            type: 'oauth',
            access: 'main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 3600_000,
          })
        }
        return Promise.resolve({
          type: 'oauth',
          access: undefined,
          refresh: 'main-refresh',
          expires: Date.now() - 1000,
        })
      },
      { models: {} },
    )

    // Capture logs via the dist sink (prime.ts compiled to dist/prime.js
    // imports dist/logger.js; the dist sink captures all events).
    const { __setLogTestSink, setLogLevel } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const setDistSink = __setLogTestSink
    setLogLevel('warn')
    setDistSink((r: any) => records.push(r))

    const mgr = (plugin as any).__primeManager
    // The fresh-check succeeds because the main quota is already
    // stored. The fire path's `getCurrentMainAccessToken` calls
    // `latestRefreshMainAccessToken` (because the cached access
    // is missing/expired) and that function throws. This is the
    // genuine token-refresh failure path.
    //
    // NOTE: the loader captures `getAuth` in a closure. The
    // refresh function is also captured. We can't easily replace
    // it from outside, so we rely on the getAuth returning a
    // no-access / past-expiry auth, which forces the refresh
    // path. The refresh function is the loader's own
    // `refreshMainAccessToken`, which internally calls the
    // Anthropic refresh endpoint. The mock fetch returns 599 for
    // everything except /v1/messages, so the token refresh
    // endpoint fetch fails with a network error, and the refresh
    // function throws — which IS a token-refresh failure.
    records.length = 0
    await mgr.tick()
    setDistSink(null)
    setLogLevel('info')

    // The token-refresh path throws because the mock fetch returns
    // 599 for the token endpoint. The adapter catches the throw
    // and tags it as `reason: 'token-refresh'` (the
    // `isPrimeTokenRefresh` flag is set by the refresh wrapper in
    // `getCurrentMainAccessToken`). The manager emits the distinct
    // `prime token refresh failed` event.
    const tokenRefreshWarns = records.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime token refresh failed',
    )
    expect(tokenRefreshWarns).toHaveLength(1)
    const fireFailedWarns = records.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime fire failed',
    )
    expect(fireFailedWarns).toHaveLength(0)
  })

  test('R3-precision: a fire-time main auth-unavailable (latestGetAuth null) failure logs the GENERIC `prime fire failed` (NOT `prime token refresh failed`)', async () => {
    // The main `getCurrentMainAccessToken` throws BEFORE reaching the
    // refresh path (auth loader is null). This is NOT a token-refresh
    // failure — it is a lifecycle / availability failure — and the
    // manager must log the generic `prime fire failed` event, not the
    // distinct `prime token refresh failed` event.
    const records: any[] = []
    globalThis.fetch = mock((input: any) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/v1/messages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      if (url.includes('/api/oauth/usage')) {
        return freshPrimeQuotaResponse({
          five_hour: {
            utilization: 0,
            resets_at: new Date(Date.now() - 1_000).toISOString(),
            checked_at: Date.now(),
          },
        })
      }
      return Promise.resolve(new Response('not-mocked', { status: 599 }))
    }) as unknown as typeof fetch

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
              resetsAt: new Date(Date.now() - 180_000).toISOString(),
              checkedAt: 1,
            },
          },
          mainQuotaCheckedAt: 1,
          mainQuotaToken: 'fp-main',
        },
        prime: { enabled: true },
      }),
    )

    const plugin = await getPlugin()
    // Provide a getAuth so lineage reconciliation and the fresh-check succeed,
    // but make the fire path's `latestGetAuth()` throw before any refresh is
    // attempted. `getCurrentMainAccessToken` will throw from the
    // `await latestGetAuth()` line, which is NOT a refresh failure.
    let authCallCount = 0
    await plugin.auth.loader(
      () => {
        authCallCount += 1
        if (authCallCount >= 3) {
          return Promise.reject(
            new Error('prime: main auth loader is not available'),
          )
        }
        return Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        })
      },
      { models: {} },
    )

    const { __setLogTestSink, setLogLevel } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const setDistSink = __setLogTestSink
    setLogLevel('warn')
    setDistSink((r: any) => records.push(r))

    const mgr = (plugin as any).__primeManager
    records.length = 0
    await mgr.tick()
    setDistSink(null)
    setLogLevel('info')

    const tokenRefreshWarns = records.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime token refresh failed',
    )
    expect(tokenRefreshWarns).toHaveLength(0)
    const fireFailedWarns = records.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime fire failed',
    )
    expect(fireFailedWarns).toHaveLength(1)
  })

  test('R3-precision: a fallback removed between fresh-check and fire logs `prime fire failed`', async () => {
    const records: any[] = []
    const dueQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(Date.now() - 180_000).toISOString(),
        checkedAt: Date.now(),
      },
    }
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'fb-access',
            refresh: 'fb-refresh',
            expires: Date.now() + 10 * 60 * 60 * 1000,
            quota: dueQuota,
          },
        ],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          mainQuota: {
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
              checkedAt: Date.now(),
            },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: 'main-access',
        },
        prime: { enabled: true },
      }),
    )

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const mgr = (plugin as any).__primeManager
    mgr.options.refreshQuota = async () => {
      const storage = await loadAccounts()
      if (!storage) throw new Error('missing test storage')
      storage.accounts = []
      await saveAccounts(storage)
      return { quota: dueQuota, fresh: true }
    }

    const { __setLogTestSink, setLogLevel } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    setLogLevel('warn')
    __setLogTestSink((record: any) => records.push(record))
    await mgr.tick()
    __setLogTestSink(null)
    setLogLevel('info')

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
    const records: any[] = []
    const dueQuota = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(Date.now() - 180_000).toISOString(),
        checkedAt: Date.now(),
      },
    }
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [
          {
            id: 'work-alt',
            type: 'oauth',
            access: 'fb-access',
            refresh: 'fb-refresh',
            expires: Date.now() + 5 * 60 * 60_000,
            quota: dueQuota,
          },
        ],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          mainQuota: {
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
              checkedAt: Date.now(),
            },
          },
          mainQuotaCheckedAt: Date.now(),
          mainQuotaToken: 'main-access',
        },
        prime: { enabled: true },
      }),
    )
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{"error":"invalid_grant"}', { status: 400 }),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 3600_000,
        }),
      { models: {} },
    )
    const storage = await loadAccounts()
    const fallback = storage!.accounts.find(
      (account) => account.id === 'work-alt',
    )!
    if (fallback.type !== 'oauth') throw new Error('expected OAuth account')
    fallback.expires = Date.now() - 1_000
    await saveAccounts(storage!)
    const mgr = (plugin as any).__primeManager
    mgr.options.refreshQuota = async () => ({ quota: dueQuota, fresh: true })

    const { __setLogTestSink, setLogLevel } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    setLogLevel('warn')
    __setLogTestSink((record: any) => records.push(record))
    await mgr.tick()
    __setLogTestSink(null)
    setLogLevel('info')

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
