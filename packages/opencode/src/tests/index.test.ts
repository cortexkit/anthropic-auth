import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  getAccountStatePath,
  hashRefreshToken,
  loadAccounts,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  resetCache1hState,
  resetDumpState,
  resetFastModeState,
  saveAccountState,
  saveAccounts,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import {
  drainSidebarWrites,
  getSidebarState,
  getSidebarStateFile,
} from '../sidebar-state'

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

// Minimal mock of the OpenCode plugin client
function createMockClient(messages?: unknown[]) {
  return {
    auth: {
      set: mock(() => Promise.resolve()),
    },
    session: {
      messages: messages
        ? mock(() => Promise.resolve({ data: messages }))
        : undefined,
      promptAsync: mock(() => Promise.resolve()),
    },
  }
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = { method: 'POST', body: '{}' } as const
let tempConfigDir: string | undefined

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
  await saveAccounts(storage)
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
  // @ts-expect-error — mock override for testing
  globalThis.setTimeout = mock((handler: () => unknown) => {
    handler()
    return 0
  })

  const mockClient = createMockClient()
  const plugin = await getPlugin(mockClient)
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

async function getPlugin(client?: ReturnType<typeof createMockClient>) {
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: client ?? createMockClient(),
  })) as Promise<any>
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
    }

    expect(packageJson.exports?.['./tui']).toEqual({
      types: './dist/tui.d.ts',
      import: './src/tui.tsx',
    })
    expect(packageJson.files).toContain('src/tui.tsx')
    expect(packageJson.files).toContain('src/sidebar-state.ts')
    expect(packageJson['oc-plugin']).toEqual(['server', 'tui'])
    expect(packageJson.scripts?.build).not.toContain('--outfile dist/tui.js')
  })

  test('package TUI entrypoint imports under OpenTUI runtime support', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `import { ensureRuntimePluginSupport } from '@opentui/solid/runtime-plugin-support/configure'
ensureRuntimePluginSupport()
const mod = await import('@cortexkit/opencode-anthropic-auth/tui')
if (mod.default?.id !== 'cortexkit.anthropic-auth' || typeof mod.default?.tui !== 'function') {
  throw new Error('invalid TUI plugin export')
}
`,
      ],
      cwd: new URL('../..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr))
    }
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
  const originalSetTimeout = globalThis.setTimeout
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalRandom = Math.random

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    Math.random = originalRandom
    resetCache1hState()
    resetDumpState()
    resetFastModeState()
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    Math.random = originalRandom
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

  test('routes to API-key fallback after main OAuth returns 429 and quota confirms exhaustion', async () => {
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
      requests.push({ url, authorization })
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
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(quotaCalls).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      authorization: 'Bearer main-access',
    })
    expect(requests[1]).toMatchObject({
      url: 'https://api.kie.ai/claude/v1/messages?beta=true',
      authorization: 'Bearer kie-key',
    })
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

    await expect(
      plugin['command.execute.before']({
        command: 'claude-cache',
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
    expect(latestCall?.body.parts[0]?.text).toContain('Window: 09-23')
    expect(latestCall?.body.parts[0]?.text).toContain('Hybrid active: yes')

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.cacheKeep).toEqual({
      enabled: true,
      startHour: 9,
      endHour: 23,
    })
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
        arguments: 'fallback-first',
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
            text: expect.stringContaining('Mode updated to `fallback-first`.'),
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
      '- Mode: `fallback-first`',
    )

    const saved = JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
    expect(saved.routing).toEqual({ mode: 'fallback-first' })
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
    globalThis.setInterval = mock((handler: () => void, delay?: number) => {
      void handler
      intervalDelays.push(Number(delay))
      return { unref() {} }
    }) as unknown as typeof setInterval
    globalThis.clearInterval = mock(() => {}) as unknown as typeof clearInterval

    const plugin = await getPlugin(createMockClient())
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
    globalThis.setInterval = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    globalThis.clearInterval = mock(() => {}) as unknown as typeof clearInterval

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
    const plugin = await getPlugin(mockClient)
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
    globalThis.setInterval = mock((handler: () => void) => {
      intervalHandlers.push(handler)
      return { unref() {} }
    }) as unknown as typeof setInterval
    globalThis.clearInterval = mock(() => {}) as unknown as typeof clearInterval

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
    const plugin = await getPlugin(mockClient)
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
      return 0
    })

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

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
    const plugin = await getPlugin(mockClient)
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
      return 0
    })

    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

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

    const plugin = await getPlugin(createMockClient())
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
      const second = await Promise.race([
        result
          .fetch(MESSAGES_URL, EMPTY_POST)
          .then((response: Response) => response.text()),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
      ])

      expect(second).toBe('message-2')
      // Background quota refresh involves file-lock I/O; wait for it to fire.
      await new Promise((r) => setTimeout(r, 50))
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
})

describe('killswitch fetch gate', () => {
  const originalFetch = globalThis.fetch
  const originalSetInterval = globalThis.setInterval

  beforeEach(() => {
    globalThis.fetch = originalFetch
    // Prevent the plugin's background quota-refresh interval from leaking a
    // real timer that fires during later tests (test-isolation flake).
    globalThis.setInterval = mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalSetInterval
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
