import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  buildAccountList,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  custodyStatusLabel,
  executeAccountCommand,
  type LogTestRecord,
  type ProviderAccountUuid,
  parseAccountCommandAction,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import {
  type Auth,
  createOpencodeClient,
  type Provider,
} from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { drainNotifications } from '../rpc/notifications'
import { createRpcClient } from '../rpc/rpc-client'
import { drainSidebarWrites } from '../sidebar-state'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { getPluginTestHandles } from './plugin-test-handles'
import { DEFAULT_FETCH_MOCK, installDefaultFetchMock } from './test-fetch'
import {
  createTimerTracking,
  type PluginTimerOverrides,
} from './timer-tracking'

let tempDir: string
let accountPath: string
const tempDirs = new Set<string>()
const originalFetch = globalThis.fetch
const timerTracking = createTimerTracking()
// Environment variables a test sets to point the plugin at its migrated
// account pool; the test's cleanup puts back their previous values.
const nativeEnvKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_AUTH_CONTENT',
] as const
const {
  activeIntervals,
  disabledPluginTimerOverrides,
  trackedClearInterval,
  trackedSetInterval,
} = timerTracking

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  fallbackOn: [401, 403, 429],
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    minimumRemaining: { five_hour: 10, seven_day: 20 },
    failClosedOnUnknownQuota: true,
    mainQuota: {
      five_hour: {
        usedPercent: 42,
        remainingPercent: 58,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 30,
        remainingPercent: 70,
        checkedAt: Date.now(),
      },
    },
  },
  accounts: [
    {
      id: 'fallback-1',
      label: 'Work account',
      type: 'oauth' as const,
      refresh: 'refresh-token-1',
      enabled: true,
    },
    {
      id: 'fallback-2',
      label: 'Personal account',
      type: 'oauth' as const,
      refresh: 'refresh-token-2',
      enabled: true,
    },
    {
      id: 'fallback-3',
      label: 'Disabled account',
      type: 'oauth' as const,
      refresh: 'refresh-token-3',
      enabled: false,
    },
  ],
})

/** Account UUIDs are branded once a provider reports them; any non-empty fixture value stands in for one. */
function isProviderAccountUuid(value: string): value is ProviderAccountUuid {
  return value.length > 0
}

/** The Anthropic provider entry OpenCode passes the auth loader; no models are configured. */
const anthropicProvider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

/**
 * The context OpenCode passes a server plugin, with a real SDK client whose
 * HTTP transport is answered in this process: message history is empty and
 * prompts are accepted, so nothing leaves the test.
 */
function hostContext(directory: string): PluginInput {
  const client = createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && /^\/session\/[^/]+\/message$/.test(path))
        return Response.json([])
      if (
        request.method === 'POST' &&
        /^\/session\/[^/]+\/prompt_async$/.test(path)
      )
        return new Response(null, { status: 204 })
      return Response.json({ name: 'NotFound' }, { status: 404 })
    },
  })
  return {
    client,
    project: {
      id: 'account-command-fixture',
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL('http://opencode.invalid'),
    experimental_workspace: { register() {} },
    $,
  }
}

/** Plugin construction starts a fallback-account refresh and exposes its promise for tests. */
function fallbackRefreshReady(hooks: Hooks): Promise<unknown> {
  const ready = getPluginTestHandles(hooks).fallbackRefreshReady
  if (!(ready instanceof Promise))
    throw new Error('Plugin did not expose its startup fallback refresh')
  return ready
}

// Synthetic OpenCode auth.json: the main OAuth login the offline migration
// moves into the native pool, beside an unrelated provider it must keep.
function mainHostAuth() {
  return {
    anthropic: {
      type: 'oauth',
      access: 'synthetic-main-access',
      refresh: 'synthetic-main-refresh',
      expires: Date.now() + 8 * 60 * 60_000,
    },
    other: { type: 'api', key: 'synthetic-unrelated-provider' },
  }
}

// Tests of stored account changes import their accounts through the real
// offline migration into an isolated native pool, which is the only store the
// account commands change; the old account file is only a migration source.
const persistence = createTestLifetimeSuite()

async function migratedAccounts(storage: AccountStorage) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-acct-pool-'))
  // A fixture that refuses the directory never registers its removal.
  persistence.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: persistence,
    legacyConfig: { ...storage },
    hostAuth: mainHostAuth(),
  })
  // The same runtime the plugin's enable, disable, remove and reorder
  // commands write through.
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  persistence.deferCleanup(() => runtime.close())
  /** Every pool file's bytes, to show that a refused change wrote nothing. */
  const files = () =>
    Promise.all(
      [
        fixture.paths.config,
        fixture.paths.state,
        fixture.paths.runtime,
        fixture.paths.journal,
      ].map((path) => readFile(path, 'utf8')),
    )
  const fallbacks = async () =>
    (await runtime.read()).accounts.filter((account) => account.id !== 'main')
  return { fixture, runtime, files, fallbacks }
}

beforeEach(async () => {
  installDefaultFetchMock()
  timerTracking.reset()
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-acct-cmd-'))
  tempDirs.add(tempDir)
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
})

afterEach(async () => {
  try {
    // Restore only the fixture's tagged mock; an untagged custom mock left
    // installed must reach the preload's leak detector, not be masked here.
    const currentFetch = globalThis.fetch as
      | (typeof fetch & { [DEFAULT_FETCH_MOCK]?: true })
      | undefined
    if (currentFetch?.[DEFAULT_FETCH_MOCK]) {
      globalThis.fetch = originalFetch
    }
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    await Promise.all(
      [...tempDirs].map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => {}),
      ),
    )
    tempDirs.clear()
    mock.restore()
  } finally {
    // Assert last so a detected leak cannot abort the cleanup above.
    expect(activeIntervals.size).toBe(0)
  }
})

afterAll(async () => {
  await Promise.all(
    [...tempDirs, tempDir].map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => {}),
    ),
  )
  tempDirs.clear()
})

// ---------------------------------------------------------------------------
// parseAccountCommandAction
// ---------------------------------------------------------------------------
describe('parseAccountCommandAction', () => {
  test('bare command returns status', async () => {
    expect(parseAccountCommandAction('')).toEqual({ type: 'status' })
  })

  test('enable with id', async () => {
    expect(parseAccountCommandAction('enable fallback-1')).toEqual({
      type: 'enable',
      id: 'fallback-1',
    })
  })

  test('disable with id', async () => {
    expect(parseAccountCommandAction('disable fallback-1')).toEqual({
      type: 'disable',
      id: 'fallback-1',
    })
  })

  test('recognizes only global mode verbs and rejects retired custody vocabulary', async () => {
    const cases: Array<[string, ReturnType<typeof parseAccountCommandAction>]> =
      [
        ['claustrum', { type: 'claustrum-mode', mode: 'claustrum' }],
        ['local', { type: 'claustrum-mode', mode: 'local' }],
        ['custody work-alt on', { type: 'usage' }],
        ['claustrum on', { type: 'usage' }],
        ['on', { type: 'usage' }],
        ['off', { type: 'usage' }],
      ]

    for (const [input, expected] of cases) {
      expect(parseAccountCommandAction(input)).toEqual(expected)
    }
  })

  test('names global mode verbs for retired custody vocabulary', async () => {
    const result = await executeAccountCommand({
      argumentsText: 'custody work-alt on',
      storage: baseStorage(),
    })

    expect(result.text).toContain('claustrum')
    expect(result.text).toContain('local')
  })

  test('remove with id', async () => {
    expect(parseAccountCommandAction('remove fallback-1')).toEqual({
      type: 'remove',
      id: 'fallback-1',
    })
  })

  test('move-up with id', async () => {
    expect(parseAccountCommandAction('move-up fallback-1')).toEqual({
      type: 'move-up',
      id: 'fallback-1',
    })
  })

  test('move-down with id', async () => {
    expect(parseAccountCommandAction('move-down fallback-1')).toEqual({
      type: 'move-down',
      id: 'fallback-1',
    })
  })

  test('enable without id returns usage', async () => {
    expect(parseAccountCommandAction('enable')).toEqual({ type: 'usage' })
  })

  test('parses enrollment-reset without arguments', async () => {
    expect(parseAccountCommandAction('enrollment-reset')).toEqual({
      type: 'enrollment-reset',
    })
    expect(parseAccountCommandAction('enrollment-reset extra')).toEqual({
      type: 'usage',
    })
  })

  test('garbage returns usage', async () => {
    expect(parseAccountCommandAction('garbage')).toEqual({ type: 'usage' })
  })

  test('add-oauth-finish with code only (no label)', async () => {
    expect(parseAccountCommandAction('add-oauth-finish abc123')).toEqual({
      type: 'add-oauth-finish',
      code: 'abc123',
    })
  })

  test('add-oauth-finish with --label', async () => {
    expect(
      parseAccountCommandAction('add-oauth-finish abc123 --label work'),
    ).toEqual({
      type: 'add-oauth-finish',
      code: 'abc123',
      label: 'work',
    })
  })

  test('add-oauth-finish --label with multi-word label', async () => {
    expect(
      parseAccountCommandAction('add-oauth-finish abc123 --label my work acct'),
    ).toEqual({
      type: 'add-oauth-finish',
      code: 'abc123',
      label: 'my work acct',
    })
  })
})

// ---------------------------------------------------------------------------
// buildAccountList
// ---------------------------------------------------------------------------
describe('buildAccountList', () => {
  test('builds list with main first, then fallbacks in order', async () => {
    const list = buildAccountList(baseStorage())

    expect(list).toHaveLength(4)
    expect(list[0]).toEqual({
      id: 'main',
      label: 'OpenCode anthropic',
      role: 'main',
      enabled: true,
      quotaPercent: 42,
    })
    expect(list[1]!.id).toBe('fallback-1')
    expect(list[1]!.role).toBe('fallback')
    expect(list[1]!.enabled).toBe(true)
    expect(list[2]!.id).toBe('fallback-2')
    expect(list[2]!.enabled).toBe(true)
    expect(list[3]!.id).toBe('fallback-3')
    expect(list[3]!.enabled).toBe(false)
  })

  test('no main quota returns null percent', async () => {
    const storage = baseStorage()
    storage.quota!.mainQuota = undefined
    const list = buildAccountList(storage)
    expect(list[0]!.quotaPercent).toBeNull()
  })

  test('no label falls back to id', async () => {
    const storage: AccountStorage = {
      version: 1,
      accounts: [{ id: 'abc', type: 'oauth', refresh: 'x' }],
    }
    const list = buildAccountList(storage)
    expect(list[1]!.label).toBe('abc')
  })

  test('buildAccountList adds tierLabel only when profile exists', async () => {
    const storage = baseStorage()
    storage.main = {
      ...storage.main!,
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: 100,
      },
    }
    Object.assign(storage.accounts[0]!, {
      profile: {
        tier: 'default_claude_max_5x',
        orgType: 'claude_team',
        checkedAt: 100,
      },
    })

    const list = buildAccountList(storage)

    expect(list[0]!.tierLabel).toBe('Max 20x')
    expect(list[1]!.tierLabel).toBe('Team · Max 5x')
    expect(list[2]!.tierLabel).toBeUndefined()
  })

  test('account modal includes optional tier label', async () => {
    const storage = baseStorage()
    storage.main = {
      ...storage.main!,
      profile: {
        tier: 'default_claude_max_20x',
        orgType: 'claude_max',
        checkedAt: 100,
      },
    }

    const result = await executeAccountCommand({ argumentsText: '', storage })

    expect(result.text).toContain('Max 20x')
  })
})

// ---------------------------------------------------------------------------
// executeAccountCommand — status
// ---------------------------------------------------------------------------
describe('executeAccountCommand status', () => {
  test('labels every custody state from the shared formatter', () => {
    expect(custodyStatusLabel('na')).toBe('n/a (OpenCode-managed)')
    expect(custodyStatusLabel('off')).toBe('not enrolled')
    expect(custodyStatusLabel('on-vault-served')).toBe('vault-served')
    expect(custodyStatusLabel('on-vault-reauth')).toBe('vault reauth')
    expect(custodyStatusLabel('on-cold')).toBe('vault cold')
    expect(custodyStatusLabel('on-identity-mismatch')).toBe('identity mismatch')
    expect(custodyStatusLabel('on-corrupt-binding')).toBe('corrupt binding')
  })

  test('bare status returns account list in text', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({ argumentsText: '', storage })
    expect(result.text).toContain('## Claude Accounts')
    expect(result.text).toContain('OpenCode anthropic')
    expect(result.text).toContain('Work account')
    expect(result.text).toContain('Personal account')
    expect(result.text).toContain('Disabled account')
    expect(result.text).toContain('42%')
    expect(result.text).toContain('(disabled)')
    expect(result.text).toContain('**OpenCode anthropic** [main] 42% · local')
    expect(result.text).toContain('**Work account** [fallback] · local')
  })

  test('renders the settled custody projection in account status text', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: '',
      storage,
      statusProjection: {
        claustrumDetection: 'available',
        accounts: [
          {
            id: 'main',
            label: 'OpenCode anthropic',
            role: 'main',
            enabled: true,
            quotaPercent: 42,
            claustrumGate: 'na',
            vaultServed: false,
            vaultReauth: false,
            custodyState: 'na',
          },
          {
            id: 'fallback-1',
            label: 'Work account',
            role: 'fallback',
            enabled: true,
            quotaPercent: null,
            claustrumGate: 'on',
            vaultServed: false,
            vaultReauth: true,
            custodyState: 'on-vault-reauth',
          },
        ],
      },
    })

    expect(result.text).toContain('Claustrum: available')
    expect(result.text).toContain('**Work account** [fallback] · vault reauth')
  })

  test('directs pending enrollment to explicit setup instead of manual approval', async () => {
    const result = await executeAccountCommand({
      argumentsText: '',
      storage: baseStorage(),
      statusProjection: {
        claustrumDetection: 'available',
        claustrumEnrollment: {
          state: 'pending',
          proposedName: 'anthropic-auth-opencode',
          requestId: 'request_123',
        },
        accounts: [],
      },
    })
    expect(result.text).toContain('Enrollment: pending approval (request_123)')
    expect(result.text).toContain(
      'npx @cortexkit/opencode-anthropic-auth setup',
    )
    expect(result.text).not.toContain('ck auth enroll approve')
  })

  test('tells users to upgrade a vault too old to connect plugins', async () => {
    const result = await executeAccountCommand({
      argumentsText: '',
      storage: baseStorage(),
      statusProjection: {
        claustrumDetection: 'available',
        claustrumEnrollment: {
          state: 'unavailable',
          proposedName: 'anthropic-auth-opencode',
          code: 'unknown_method',
        },
        accounts: [],
      },
    })
    expect(result.text).toContain(
      'Enrollment: this Claustrum vault is too old to connect plugins. Run `ck upgrade` to move to Claustrum v0.2.0 or newer (read "Upgrading from v0.1.3" in its release notes first).',
    )
    expect(result.text).not.toContain(
      'this Claustrum vault does not support connecting plugins',
    )
    expect(result.text).not.toContain('temporarily unavailable')
  })

  test('directs an approved but unconfigured host to explicit setup', async () => {
    const result = await executeAccountCommand({
      argumentsText: '',
      storage: baseStorage(),
      statusProjection: {
        claustrumDetection: 'available',
        claustrumEnrollment: {
          state: 'approved',
          proposedName: 'anthropic-auth-opencode',
          approvedName: 'anthropic-auth-opencode',
          tokenGeneration: 1,
        },
        accounts: [],
      },
    })
    expect(result.text).toContain('scoped serving not active yet')
    expect(result.text).toContain(
      'npx @cortexkit/opencode-anthropic-auth setup',
    )
    expect(result.text).not.toContain('ck auth grant')
  })

  test('does not tell an approved vault-served account to run setup again', async () => {
    const storage = baseStorage()
    storage.claustrum = { mode: 'claustrum', scopedRoster: true }
    const result = await executeAccountCommand({
      argumentsText: '',
      storage,
      statusProjection: {
        claustrumDetection: 'available',
        claustrumEnrollment: {
          state: 'approved',
          proposedName: 'anthropic-auth-opencode',
          approvedName: 'anthropic-auth-opencode',
          tokenGeneration: 1,
        },
        accounts: [
          {
            id: 'main',
            label: 'OpenCode anthropic',
            role: 'main',
            enabled: true,
            quotaPercent: 42,
            claustrumGate: 'na',
            vaultServed: true,
            vaultReauth: false,
            custodyState: 'on-vault-served',
          },
        ],
      },
    })
    expect(result.text).toContain(
      'Enrollment: approved as enrolled:anthropic-auth-opencode',
    )
    expect(result.text).toContain('**OpenCode anthropic** [main] 42% · vault')
    expect(result.text).not.toContain('scoped serving not active yet')
    expect(result.text).not.toContain('Quit the host and run')
  })

  test('does not interpolate unsafe enrollment identifiers into shell commands', async () => {
    const result = await executeAccountCommand({
      argumentsText: '',
      storage: baseStorage(),
      statusProjection: {
        claustrumDetection: 'available',
        claustrumEnrollment: {
          state: 'pending',
          proposedName: 'anthropic-auth-opencode',
          requestId: 'request`touch /tmp/bad`',
        },
        accounts: [],
      },
    })
    expect(result.text).toContain('pending approval')
    expect(result.text).toContain(
      'npx @cortexkit/opencode-anthropic-auth setup',
    )
    expect(result.text).not.toContain('request`touch')
  })

  test('terminal enrollment reset delegates to enrollment state without a stored custody-mode prerequisite', async () => {
    const resetEnrollment = mock(async () => ({ text: 'reset' }))
    for (const mode of ['local', 'claustrum'] as const) {
      const storage = baseStorage()
      storage.claustrum = { mode }
      const result = await executeAccountCommand({
        argumentsText: 'enrollment-reset',
        storage,
        resetEnrollment,
      })
      expect(result.text).toBe('reset')
    }
    expect(resetEnrollment).toHaveBeenCalledTimes(2)
    const unavailable = await executeAccountCommand({
      argumentsText: 'enrollment-reset',
      storage: baseStorage(),
    })
    expect(unavailable.text).toBe('Claustrum enrollment reset is unavailable.')
  })

  test('projects a scoped fallback conservatively without a status projection', async () => {
    const storage = baseStorage()
    storage.claustrum = { mode: 'claustrum', scopedRoster: true }
    const account = storage.accounts[0]
    if (account?.type !== 'oauth') throw new Error('missing OAuth fixture')
    account.claustrumScopedCredentialId = 'oauth:anthropic:work'
    const accountUuid = 'account-work'
    if (!isProviderAccountUuid(accountUuid))
      throw new Error('missing account UUID fixture')
    account.anthropicAccountUuid = accountUuid
    account.claustrumScopedState = 'active'

    const result = await executeAccountCommand({ argumentsText: '', storage })
    expect(result.text).toContain('**Work account** [fallback] · vault cold')
    expect(result.text).not.toContain('handle')
  })

  test('usage returns usage text', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'garbage',
      storage,
    })
    expect(result.text).toContain('Usage:')
    expect(result.text).toContain('/claude-account enable')
  })
})

describe('executeAccountCommand global Claustrum mode', () => {
  test('names the two accepted mode verbs in retired custody usage', async () => {
    const result = await executeAccountCommand({
      argumentsText: 'claustrum on',
      storage: baseStorage(),
    })

    expect(result.text).toContain('/claude-account claustrum')
    expect(result.text).toContain('/claude-account local')
  })

  persistence.test(
    'refuses to bypass the coordinator when no mode transition is supplied',
    async () => {
      const { runtime, files } = await migratedAccounts(baseStorage())
      const before = await files()

      const result = await executeAccountCommand({
        argumentsText: 'claustrum',
        storage: (await runtime.read()).policyStorage,
      })

      expect(result.text).toBe('Claustrum mode transition is unavailable.')
      expect(await files()).toEqual(before)
      expect((await runtime.read()).mode).toBe('local')
    },
  )

  test('routes a requested global mode through its transition seam', async () => {
    const modes: string[] = []
    const result = await executeAccountCommand({
      argumentsText: 'claustrum',
      storage: baseStorage(),
      transition: async (mode) => {
        modes.push(mode)
        return { text: 'coordinator committed' }
      },
    })

    expect(result.text).toBe('coordinator committed')
    expect(modes).toEqual(['claustrum'])
  })
})

// ---------------------------------------------------------------------------
// executeAccountCommand — enable / disable
// ---------------------------------------------------------------------------
describe('executeAccountCommand enable/disable', () => {
  test('enable sets enabled flag on result', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'enable fallback-3',
      storage,
    })
    expect(result.text).toContain('enabled')
    expect(result.updated).toEqual({
      id: 'fallback-3',
      action: 'enable',
      enabled: true,
    })
  })

  test('disable sets enabled flag on result', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'disable fallback-1',
      storage,
    })
    expect(result.text).toContain('disabled')
    expect(result.updated).toEqual({
      id: 'fallback-1',
      action: 'disable',
      enabled: false,
    })
  })

  test('enable main is rejected', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'enable main',
      storage,
    })
    expect(result.text).toContain('Cannot enable the main account')
    expect(result.updated).toBeUndefined()
  })

  test('disable main is rejected', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'disable main',
      storage,
    })
    expect(result.text).toContain('Cannot disable the main account')
    expect(result.updated).toBeUndefined()
  })

  test('enable non-existent returns not found', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'enable nonexistent',
      storage,
    })
    expect(result.text).toContain('not found')
    expect(result.updated).toBeUndefined()
  })

  persistence.test('persistent enable mutates store', async () => {
    const storage = baseStorage()
    storage.accounts[2]!.enabled = false
    const { runtime, fallbacks } = await migratedAccounts(storage)
    expect((await fallbacks())[2]?.enabled).toBe(false)

    await runtime.setEnabled('fallback-3', true)
    expect((await fallbacks())[2]).toMatchObject({
      id: 'fallback-3',
      enabled: true,
    })
  })

  persistence.test('persistent disable mutates store', async () => {
    const { runtime, fallbacks } = await migratedAccounts(baseStorage())

    await runtime.setEnabled('fallback-1', false)
    expect((await fallbacks())[0]).toMatchObject({
      id: 'fallback-1',
      enabled: false,
    })
  })
})

// ---------------------------------------------------------------------------
// executeAccountCommand — remove
// ---------------------------------------------------------------------------
describe('executeAccountCommand remove', () => {
  test('remove returns updated', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'remove fallback-1',
      storage,
    })
    expect(result.text).toContain('removed')
    expect(result.updated).toEqual({
      id: 'fallback-1',
      action: 'remove',
    })
  })

  test('refuses to remove a scoped OAuth row while it remains in the vault', async () => {
    const storage = {
      ...baseStorage(),
      claustrum: { mode: 'claustrum' as const },
    }
    const fallback = storage.accounts.find(
      (account) => account.id === 'fallback-1',
    )
    if (fallback?.type !== 'oauth') throw new Error('missing OAuth fixture')
    fallback.claustrumScopedCredentialId = 'oauth:anthropic:fallback-1'
    const result = await executeAccountCommand({
      argumentsText: 'remove fallback-1',
      storage,
    })
    expect(result.text).toContain('managed by Claustrum')
    expect(result.updated).toBeUndefined()
  })

  test('remove main is rejected', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'remove main',
      storage,
    })
    expect(result.text).toContain('Cannot remove the main account')
    expect(result.updated).toBeUndefined()
  })

  test('remove non-existent returns not found', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'remove nonexistent',
      storage,
    })
    expect(result.text).toContain('not found')
    expect(result.updated).toBeUndefined()
  })

  persistence.test('persistent remove mutates store', async () => {
    const { runtime, fallbacks } = await migratedAccounts(baseStorage())

    await runtime.remove('fallback-1')
    const remaining = await fallbacks()
    expect(remaining).toHaveLength(2)
    expect(remaining[0]?.id).toBe('fallback-2')
  })

  persistence.test(
    'persistent remove non-existent is refused and changes nothing',
    async () => {
      const { runtime, files, fallbacks } = await migratedAccounts(
        baseStorage(),
      )
      const before = await files()

      await expect(runtime.remove('nonexistent')).rejects.toMatchObject({
        kind: 'unknown-row',
      })
      expect(await files()).toEqual(before)
      expect((await fallbacks()).map((account) => account.id)).toEqual([
        'fallback-1',
        'fallback-2',
        'fallback-3',
      ])
    },
  )
})

// ---------------------------------------------------------------------------
// executeAccountCommand — reorder (move-up / move-down)
// ---------------------------------------------------------------------------
describe('executeAccountCommand reorder', () => {
  test('move-up returns updated with new order', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'move-up fallback-2',
      storage,
    })
    expect(result.text).toContain('moved up')
    expect(result.updated).toEqual({
      id: 'fallback-2',
      action: 'reorder',
      previousOrder: ['fallback-1', 'fallback-2', 'fallback-3'],
      newOrder: ['fallback-2', 'fallback-1', 'fallback-3'],
    })
  })

  test('move-up first item is no-op', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'move-up fallback-1',
      storage,
    })
    expect(result.text).toContain('already first')
    expect(result.updated).toBeUndefined()
  })

  test('move-down returns updated with new order', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'move-down fallback-1',
      storage,
    })
    expect(result.text).toContain('moved down')
    expect(result.updated).toEqual({
      id: 'fallback-1',
      action: 'reorder',
      previousOrder: ['fallback-1', 'fallback-2', 'fallback-3'],
      newOrder: ['fallback-2', 'fallback-1', 'fallback-3'],
    })
  })

  test('move-down last item is no-op', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'move-down fallback-3',
      storage,
    })
    expect(result.text).toContain('already last')
    expect(result.updated).toBeUndefined()
  })

  test('move-up non-existent returns not found', async () => {
    const storage = baseStorage()
    const result = await executeAccountCommand({
      argumentsText: 'move-up nonexistent',
      storage,
    })
    expect(result.text).toContain('not found')
    expect(result.updated).toBeUndefined()
  })

  persistence.test('persistent reorder mutates store', async () => {
    const { runtime, fallbacks } = await migratedAccounts(baseStorage())

    await runtime.reorder(['fallback-2', 'fallback-1', 'fallback-3'])
    expect((await fallbacks()).map((a) => a.id)).toEqual([
      'fallback-2',
      'fallback-1',
      'fallback-3',
    ])
  })
})

// ---------------------------------------------------------------------------
// INFO log emission through the plugin's /claude menu after offline migration
// ---------------------------------------------------------------------------
describe('account command INFO logs (via plugin)', () => {
  // Per-test lifetimes: fixture roots outlive the whole test body and any work
  // the body registered, and are removed only after the plugins are disposed.
  const lifetimes = createTestLifetimeSuite()
  const test = lifetimes.test
  let capturedRecords: LogTestRecord[]

  beforeEach(() => {
    capturedRecords = []
    __setLogTestSink((record) => {
      capturedRecords.push(record)
    })
  })

  afterEach(() => {
    __setLogTestSink(null)
  })

  // Synthetic OpenCode auth.json for the migration; see mainHostAuth.
  const hostAuth = mainHostAuth

  type Migrated = Awaited<ReturnType<typeof migrateNativeOpencodeFixture>> & {
    getPlugin: (
      timerOverrides?: PluginTimerOverrides,
      runtimeOverrides?: Record<string, unknown>,
    ) => Promise<Hooks>
  }

  /**
   * Import `storage` through the real offline migration, point this process at
   * the migrated pool, and return a plugin factory for that pool. Plugins are
   * constructed only after the migration committed, as OpenCode would start
   * them after offline setup.
   */
  async function migrate(storage: AccountStorage): Promise<Migrated> {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-acct-native-'))
    const plugins: Hooks[] = []
    const savedEnv = new Map(
      nativeEnvKeys.map((key) => [key, process.env[key]] as const),
    )
    // Registered before the migration fixture takes ownership of its
    // directory (and registers that directory's removal), so this runs first:
    // plugins stop (closing their RPC servers) and pending sidebar writes land
    // before any fixture file is removed. The environment is restored even when
    // a dispose fails.
    lifetimes.deferCleanup(async () => {
      const results = await Promise.allSettled(
        plugins
          .splice(0)
          .map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
      )
      try {
        await drainSidebarWrites()
      } finally {
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
    // A fixture that refuses the directory never registers its removal, so
    // remove it here as well.
    lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
    const fixture = await migrateNativeOpencodeFixture({
      root,
      lifetime: lifetimes,
      legacyConfig: { ...storage },
      hostAuth: hostAuth(),
    })
    for (const [key, value] of Object.entries(fixture.env))
      process.env[key] = value
    delete process.env.OPENCODE_AUTH_CONTENT
    return {
      ...fixture,
      async getPlugin(timerOverrides, runtimeOverrides = {}) {
        // A project directory starts the plugin's menu RPC server in the
        // fixture's RPC directory.
        const creation = AnthropicAuthPlugin(hostContext(fixture.root), {
          ...disabledPluginTimerOverrides(),
          ...timerOverrides,
          ...runtimeOverrides,
        })
        lifetimes.trackDetached(creation)
        const plugin = await creation
        plugins.push(plugin)
        await fallbackRefreshReady(plugin)
        return plugin
      },
    }
  }

  /** Open /claude for a TUI-connected session, as the slash command does. */
  async function openClaudeMenu(plugin: Hooks, sessionId: string) {
    // The plugin counts a session's TUI as connected only while that session
    // has recently drained its RPC notification queue, which the TUI polls as a
    // heartbeat. Draining here makes /claude queue its menu as a notification
    // for the TUI instead of replying in the chat with text.
    drainNotifications(0, sessionId)
    const execute = plugin['command.execute.before']
    if (!execute) throw new Error('Plugin did not install its command hook')
    await expect(
      execute(
        { command: 'claude', arguments: '', sessionID: sessionId },
        { parts: [] },
      ),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const notices = drainNotifications(0, sessionId)
    const notice = notices.at(-1)
    if (notice?.type !== 'open-menu')
      throw new Error('Expected the /claude menu notification')
    drainNotifications(notice.id, sessionId)
    return notice.payload
  }

  /**
   * Submit one Claude menu action through the plugin's RPC server, the way
   * the TUI renderer does after the user picks it.
   */
  async function applyMenuAction(
    fixture: Migrated,
    plugin: Hooks,
    request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
    sessionId = 'ses_test',
  ): Promise<CommandApplyResult> {
    await openClaudeMenu(plugin, sessionId)
    // globalThis.fetch is currently a mock for provider (Anthropic) requests
    // that refuses loopback URLs. Send only the call to the plugin's local RPC
    // server (127.0.0.1) through the fetch captured when this file loaded,
    // which the test preload limits to loopback hosts.
    const providerFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new URL(input instanceof Request ? input.url : String(input))
          .hostname === '127.0.0.1'
          ? originalFetch(input, init)
          : providerFetch(input, init),
      { preconnect: providerFetch.preconnect },
    )
    try {
      return await createRpcClient(
        fixture.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR,
        process.pid,
      ).applyMenu({ command: 'claude', sessionId, ...request })
    } finally {
      globalThis.fetch = providerFetch
    }
  }

  /** Accounts as the native runtime reads them back from the migrated pool. */
  async function readNativeAccounts(fixture: Migrated) {
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    try {
      return (await runtime.read()).accounts
    } finally {
      runtime.close()
    }
  }

  function findCommandsLog(message: string): LogTestRecord | undefined {
    return capturedRecords.find(
      (r) =>
        r.level === 'info' && r.channel === 'commands' && r.message === message,
    )
  }

  test('enable emits INFO log and persists', async () => {
    const storage = baseStorage()
    storage.accounts[2]!.enabled = false
    const fixture = await migrate(storage)
    const plugin = await fixture.getPlugin()

    const result = await applyMenuAction(fixture, plugin, {
      sectionId: 'Accounts',
      actionId: 'enable',
      values: { id: 'fallback-3' },
    })
    expect(result.ok).toBe(true)
    const rec = findCommandsLog('account enabled')
    expect(rec).toBeDefined()
    expect(rec!.payload).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-3')
    expect(rec!.payload!.enabled).toBe(true)
    // No token in payload
    const payloadStr = JSON.stringify(rec!.payload)
    expect(payloadStr).not.toContain('refresh')
    expect(payloadStr).not.toContain('token')
    expect(payloadStr).not.toContain('access')
    expect(payloadStr).not.toContain('apiKey')
    // Persisted
    const accounts = await readNativeAccounts(fixture)
    expect(accounts.find((a) => a.id === 'fallback-3')?.enabled).toBe(true)
  })

  test('disable emits INFO log and persists', async () => {
    const fixture = await migrate(baseStorage())
    const plugin = await fixture.getPlugin()

    const result = await applyMenuAction(fixture, plugin, {
      sectionId: 'Accounts',
      actionId: 'disable',
      values: { id: 'fallback-1' },
    })
    expect(result.ok).toBe(true)
    const rec = findCommandsLog('account disabled')
    expect(rec).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-1')
    expect(rec!.payload!.enabled).toBe(false)
    // Persisted
    const accounts = await readNativeAccounts(fixture)
    expect(accounts.find((a) => a.id === 'fallback-1')?.enabled).toBe(false)
  })

  test('remove emits INFO log and persists', async () => {
    const fixture = await migrate(baseStorage())
    const plugin = await fixture.getPlugin()

    const result = await applyMenuAction(fixture, plugin, {
      sectionId: 'Accounts',
      actionId: 'remove',
      values: { id: 'fallback-1' },
      confirmed: true,
    })
    expect(result.ok).toBe(true)
    const rec = findCommandsLog('account removed')
    expect(rec).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-1')
    // No token in payload
    const payloadStr = JSON.stringify(rec!.payload)
    expect(payloadStr).not.toContain('refresh')
    expect(payloadStr).not.toContain('token')
    // Persisted
    const fallbacks = (await readNativeAccounts(fixture)).filter(
      (a) => a.id !== 'main',
    )
    expect(fallbacks).toHaveLength(2)
    expect(fallbacks[0]!.id).toBe('fallback-2')
  })

  test('reorder emits INFO log and persists', async () => {
    const fixture = await migrate(baseStorage())
    const plugin = await fixture.getPlugin()

    const result = await applyMenuAction(fixture, plugin, {
      sectionId: 'Accounts',
      actionId: 'move-up',
      values: { id: 'fallback-2' },
    })
    expect(result.ok).toBe(true)
    const rec = findCommandsLog('account reordered')
    expect(rec).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-2')
    // No token in payload
    const payloadStr = JSON.stringify(rec!.payload)
    expect(payloadStr).not.toContain('refresh')
    expect(payloadStr).not.toContain('token')
    // Persisted
    expect(
      (await readNativeAccounts(fixture))
        .filter((a) => a.id !== 'main')
        .map((a) => a.id),
    ).toEqual(['fallback-2', 'fallback-1', 'fallback-3'])
  })

  test('status emits no setting-change log', async () => {
    const fixture = await migrate(baseStorage())
    const plugin = await fixture.getPlugin()

    // Opening /claude reads account status for its Accounts section.
    const payload = await openClaudeMenu(plugin, 'ses_test')
    const accounts = payload.menu.sections.find(
      (section) => section.id === 'Accounts',
    )
    expect(accounts?.lines.join('\n')).toContain('Work account')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  test('retired custody syntax is not handled and leaves native account storage untouched', async () => {
    const fixture = await migrate(baseStorage())
    const before = await Promise.all(
      [fixture.paths.config, fixture.paths.state].map(async (path) => ({
        bytes: await readFile(path, 'utf8'),
        mtimeMs: (await fs.stat(path)).mtimeMs,
      })),
    )
    const plugin = await fixture.getPlugin()
    drainNotifications(0, 'ses_test')
    const execute = plugin['command.execute.before']
    if (!execute) throw new Error('Plugin did not install its command hook')

    // The old /claude-account alias is no longer registered; the plugin
    // passes it through without handling, notifying or mutating anything.
    await expect(
      execute(
        {
          command: 'claude-account',
          arguments: 'custody fallback-1 on',
          sessionID: 'ses_test',
        },
        { parts: [] },
      ),
    ).resolves.toBeUndefined()

    expect(drainNotifications(0, 'ses_test')).toEqual([])
    const after = await Promise.all(
      [fixture.paths.config, fixture.paths.state].map(async (path) => ({
        bytes: await readFile(path, 'utf8'),
        mtimeMs: (await fs.stat(path)).mtimeMs,
      })),
    )
    expect(after).toEqual(before)
  })

  test('claustrum command gives scoped setup guidance without changing local storage', async () => {
    const fixture = await migrate(baseStorage())
    const plugin = await fixture.getPlugin()
    // The host passes the loader the Anthropic entry the migration left in
    // OpenCode's auth.json: a placeholder login that holds no usable token.
    const activation: Auth = JSON.parse(
      await readFile(fixture.hostAuthPath, 'utf8'),
    ).anthropic
    const loader = plugin.auth?.loader
    if (!loader) throw new Error('Plugin did not install its auth loader')
    await loader(async () => activation, anthropicProvider)
    const before = await readFile(fixture.paths.config, 'utf8')
    const result = await applyMenuAction(fixture, plugin, {
      sectionId: 'Accounts',
      actionId: 'custody-mode',
      values: { mode: 'claustrum' },
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('setup')
    expect(await readFile(fixture.paths.config, 'utf8')).toBe(before)
  })

  test('does not retain a background interval unless the helper opts in', async () => {
    const fixture = await migrate(baseStorage())
    await fixture.getPlugin()
    // The Prime timer (the opt-in five-hour window starter) registers at
    // startup alongside fallback refresh, even when Prime is off.
    expect(timerTracking.disabledIntervalCalls).toBe(2)
    expect(activeIntervals.size).toBe(0)

    await timerTracking.withTrackedInterval(async () => {
      await fixture.getPlugin({
        setInterval: trackedSetInterval,
        clearInterval: trackedClearInterval,
      })
      // The second instance shares the Prime timer; only its fallback refresh is new.
      expect(activeIntervals.size).toBe(1)
    })
    expect(activeIntervals.size).toBe(0)
  })
})
