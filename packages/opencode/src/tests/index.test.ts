import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  acquireRefreshFileLock,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  getAccountStatePath,
  hashRefreshToken,
  type LogTestRecord,
  loadAccounts,
  type OAuthAccount,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  PROFILE_TTL_MS,
  resetCache1hState,
  resetDumpState,
  resetFastModeState,
  saveAccountState,
  saveAccounts,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
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

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// Minimal mock of the OpenCode plugin client
function createMockClient(
  messages?: unknown[],
  getSessionStatuses?: () => Record<string, { type: string }>,
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
        ? mock(() => Promise.resolve({ data: getSessionStatuses() }))
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
  const plugin = await getPlugin(mockClient, { setTimeout: setTimeoutMock })
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

async function getPlugin(
  client?: ReturnType<typeof createMockClient>,
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
      refreshToken: refresh,
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
    await drainSidebarWrites()
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.id === 'fallback-1',
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
    await drainSidebarWrites()
    const state = await waitForSidebarState(
      (candidate) => candidate.fallbacks[0]?.id === 'fallback-1',
    )
    expect(state.fallbacks[0]?.needsReauth).toBe(false)
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
          quota: { enabled: false },
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

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const state = await waitForSidebarState(
      (candidate) => candidate.main.quota?.five_hour?.usedPercent === 12,
    )
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

  test('fallback-first refreshes current main quota for sidebar when persisted main quota belongs to an old token', async () => {
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
        candidate.main.quota?.five_hour?.usedPercent === 12,
    )
    expect(state.route).toBe('fallback-first')
    expect(state.main.quota?.seven_day?.usedPercent).toBe(34)
    expect(mainQuotaCalls).toBe(1)
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
    const required = [
      'claude-account',
      'claude-cache',
      'claude-cachekeep',
      'claude-quota',
      'claude-dump',
      'claude-fast',
      'claude-routing',
      'claude-killswitch',
      'claude-logging',
    ]
    for (const name of required) {
      expect(registered).toContain(name)
    }

    // The config hook must not register extra claude-* commands beyond the
    // modalCommands set (drift in either direction is a bug). Exactly the 9
    // required names should be claude-* keys — no more, no less. (The foreign
    // 'other-plugin-cmd' is excluded from this count via the claude- prefix.)
    const claudeRegistered = registered.filter((name) =>
      name.startsWith('claude-'),
    )
    expect(claudeRegistered).toHaveLength(required.length)
    expect([...claudeRegistered].sort()).toEqual([...required].sort())
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

  test('main token rotation clears a stale bound profile before display', async () => {
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
    globalThis.fetch = mock((input: string | URL | Request) =>
      Promise.resolve(
        extractUrl(input).includes('/api/oauth/profile')
          ? new Response('failed', { status: 500 })
          : new Response('ok'),
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

    expect(text).not.toContain('Max 20x')
    const clearedStorage = await waitForAccountStorage(
      (storage) => storage?.main?.profile === undefined,
    )
    expect(clearedStorage?.main?.profile).toBeUndefined()
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
    expect(reloadedFallback.profile).toBeUndefined()
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
        checkedAt: Date.now(),
        tokenFingerprint: tokenFingerprint(liveAccess),
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
      tokenFingerprint: tokenFingerprint('new-main-access'),
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

  test('token rotation hydrates the new profile once and restores its tier label', async () => {
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
        storage?.main?.profile?.tokenFingerprint ===
        tokenFingerprint('token-a'),
    )
    liveAccess = 'token-b'
    expect(await showAccounts()).toContain('Max 20x')
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.tokenFingerprint ===
        tokenFingerprint('token-b'),
    )
    expect(await showAccounts()).toContain('Max 20x')

    expect(profileCalls).toEqual(['Bearer token-a', 'Bearer token-b'])
    expect((await loadAccounts())?.main?.profile?.tokenFingerprint).toBe(
      tokenFingerprint('token-b'),
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

  test('completed profile hydrations do not block later token generations', async () => {
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

    for (let generation = 0; generation < 66; generation++) {
      liveAccess = `token-${generation}`
      await showAccounts()
      const expectedFingerprint = tokenFingerprint(liveAccess)
      await waitForAccountStorage(
        (storage) =>
          storage?.main?.profile?.tokenFingerprint === expectedFingerprint,
      )
    }
    liveAccess = 'token-0'
    await showAccounts()
    await waitForAccountStorage(
      (storage) =>
        storage?.main?.profile?.tokenFingerprint ===
        tokenFingerprint(liveAccess),
    )

    expect(profileCalls).toBe(67)
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

    const plugin = await getPlugin(createMockClient(), {
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
    const plugin = await getPlugin(mockClient, {
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
    const plugin = await getPlugin(mockClient, {
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
    const plugin = await getPlugin(mockClient, { setTimeout: setTimeoutMock })
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

    const plugin = await getPlugin(createMockClient(), {
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

    expect(recovered.status).toBe(200)
    expect(messageRequests).toBe(1)
    const savedState = JSON.parse(await readFile(getAccountStatePath(), 'utf8'))
    expect(savedState.main?.lastRefreshError).toBeUndefined()
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
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.updated',
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
    // response emits its final fallback outcome. The post-idle session update must
    // flush a notice queued after that completion event without starting another turn.
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
    await plugin.event?.({
      event: {
        type: 'session.updated',
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
      (): Record<string, { type: string }> =>
        noticeStatusChecks++ === 0
          ? { ses_fable_filter: { type: 'busy' } }
          : {},
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

    const firstOpus = await result.fetch(MESSAGES_URL, request)
    await firstOpus.text()
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
      expect(state.main.quotaToken).toBe(tokenFingerprint('main-access'))
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
      expect(state.main.quotaToken).toBe(tokenFingerprint('main-access'))
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

    test('main header push skips persistence after access-token rotation', async () => {
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
          accounts: [],
          quota: {
            enabled: false,
            mainQuota: existingQuota,
            mainQuotaCheckedAt: 1,
            mainQuotaToken: tokenFingerprint('new-main-access'),
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
      expect(rawState.main.quota).toEqual(existingQuota)
      expect(rawState.main.quotaToken).toBe(tokenFingerprint('new-main-access'))
      expect(reloaded?.quota?.mainQuota).toEqual(existingQuota)
      expect(reloaded?.quota?.mainQuotaToken).toBe(
        tokenFingerprint('new-main-access'),
      )
      __setLogTestSink(null)
      setLogLevel('info')
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
