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
  custodyStatusLabel,
  executeAccountCommand,
  type LogTestRecord,
  loadAccounts,
  parseAccountCommandAction,
  removeAccountPersistent,
  reorderAccountsPersistent,
  saveAccounts,
  setAccountEnabledPersistent,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import { drainNotifications } from '../rpc/notifications'
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
    const cases = [
      ['claustrum', { type: 'claustrum-mode', mode: 'claustrum' }],
      ['local', { type: 'claustrum-mode', mode: 'local' }],
      ['custody work-alt on', { type: 'usage' }],
      ['claustrum on', { type: 'usage' }],
      ['on', { type: 'usage' }],
      ['off', { type: 'usage' }],
    ]

    for (const [input, expected] of cases as Array<[string, unknown]>) {
      expect(parseAccountCommandAction(input)).toEqual(expected as never)
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
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const loaded = await loadAccounts(accountPath)
    const list = buildAccountList(loaded!)

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
    expect(custodyStatusLabel('on-identity-mismatch' as never)).toBe(
      'identity mismatch',
    )
    expect(custodyStatusLabel('on-corrupt-binding' as never)).toBe(
      'corrupt binding',
    )
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
      'bunx @cortexkit/opencode-anthropic-auth setup',
    )
    expect(result.text).not.toContain('ck auth enroll approve')
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
      'bunx @cortexkit/opencode-anthropic-auth setup',
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
      'bunx @cortexkit/opencode-anthropic-auth setup',
    )
    expect(result.text).not.toContain('request`touch')
  })

  test('routes enrollment-reset only in Claustrum mode', async () => {
    const local = await executeAccountCommand({
      argumentsText: 'enrollment-reset',
      storage: baseStorage(),
      resetEnrollment: async () => ({ text: 'unexpected' }),
    })
    expect(local.text).toContain('only in Claustrum mode')

    const storage = baseStorage()
    storage.claustrum = { mode: 'claustrum' }
    const resetEnrollment = mock(async () => ({ text: 'reset' }))
    const result = await executeAccountCommand({
      argumentsText: 'enrollment-reset',
      storage,
      resetEnrollment,
    })
    expect(result.text).toBe('reset')
    expect(resetEnrollment).toHaveBeenCalledTimes(1)
  })

  test('projects a scoped fallback conservatively without a status projection', async () => {
    const storage = baseStorage()
    storage.claustrum = { mode: 'claustrum', scopedRoster: true }
    const account = storage.accounts[0]
    if (account?.type !== 'oauth') throw new Error('missing OAuth fixture')
    account.claustrumScopedCredentialId = 'oauth:anthropic:work'
    account.anthropicAccountUuid = 'account-work' as never
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

  test('refuses to bypass the coordinator when no mode transition is supplied', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)

    const result = await executeAccountCommand({
      argumentsText: 'claustrum',
      storage,
      path: accountPath,
    })

    expect(result.text).toBe('Claustrum mode transition is unavailable.')
    expect((await loadAccounts(accountPath))?.claustrum?.mode).toBeUndefined()
  })

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

  test('persistent enable mutates store', async () => {
    const storage = baseStorage()
    storage.accounts[2]!.enabled = false
    await saveAccounts(storage, accountPath)

    await setAccountEnabledPersistent('fallback-3', true, accountPath)
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts[2]?.enabled).toBe(true)
  })

  test('persistent disable mutates store', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)

    await setAccountEnabledPersistent('fallback-1', false, accountPath)
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts[0]?.enabled).toBe(false)
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

  test('persistent remove mutates store', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)

    const existed = await removeAccountPersistent('fallback-1', accountPath)
    expect(existed).toBe(true)
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts).toHaveLength(2)
    expect(loaded?.accounts[0]?.id).toBe('fallback-2')
  })

  test('persistent remove non-existent returns false', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)

    const existed = await removeAccountPersistent('nonexistent', accountPath)
    expect(existed).toBe(false)
  })
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

  test('persistent reorder mutates store', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)

    await reorderAccountsPersistent(
      ['fallback-2', 'fallback-1', 'fallback-3'],
      accountPath,
    )
    const loaded = await loadAccounts(accountPath)
    expect(loaded?.accounts.map((a) => a.id)).toEqual([
      'fallback-2',
      'fallback-1',
      'fallback-3',
    ])
  })
})

// ---------------------------------------------------------------------------
// INFO log emission via plugin command.execute.before
// ---------------------------------------------------------------------------
describe('account command INFO logs (via plugin)', () => {
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

  function createMockClient() {
    return {
      auth: { set: mock(() => Promise.resolve()) },
      session: {
        promptAsync: mock(() => Promise.resolve()),
      },
    }
  }

  async function getPlugin(
    timerOverrides?: PluginTimerOverrides,
    runtimeOverrides: Record<string, unknown> = {},
  ) {
    const defaultTimerOverrides = disabledPluginTimerOverrides()
    const plugin = (await (
      AnthropicAuthPlugin as unknown as (
        ctx: Parameters<typeof AnthropicAuthPlugin>[0],
        timers?: PluginTimerOverrides,
      ) => ReturnType<typeof AnthropicAuthPlugin>
    )(
      {
        // @ts-expect-error: minimal mock for testing
        client: createMockClient(),
      },
      { ...defaultTimerOverrides, ...timerOverrides, ...runtimeOverrides },
    )) as any
    await plugin.__fallbackRefreshReady
    return plugin
  }

  async function executeCommand(
    plugin: any,
    command: string,
    args: string,
  ): Promise<void> {
    await expect(
      plugin['command.execute.before']({
        command,
        arguments: args,
        sessionID: 'ses_test',
      }),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
  }

  async function readConfigFile(): Promise<any> {
    return JSON.parse(
      await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
    )
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
    await saveAccounts(storage, accountPath)
    const plugin = await getPlugin()

    await executeCommand(plugin, 'claude-account', 'enable fallback-3')
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
    const raw = await readConfigFile()
    expect(raw.accounts[2].enabled).toBe(true)
  })

  test('disable emits INFO log and persists', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const plugin = await getPlugin()

    await executeCommand(plugin, 'claude-account', 'disable fallback-1')
    const rec = findCommandsLog('account disabled')
    expect(rec).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-1')
    expect(rec!.payload!.enabled).toBe(false)
    // Persisted
    const raw = await readConfigFile()
    expect(raw.accounts[0].enabled).toBe(false)
  })

  test('remove emits INFO log and persists', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const plugin = await getPlugin()

    await executeCommand(plugin, 'claude-account', 'remove fallback-1')
    const rec = findCommandsLog('account removed')
    expect(rec).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-1')
    // No token in payload
    const payloadStr = JSON.stringify(rec!.payload)
    expect(payloadStr).not.toContain('refresh')
    expect(payloadStr).not.toContain('token')
    // Persisted
    const raw = await readConfigFile()
    expect(raw.accounts).toHaveLength(2)
    expect(raw.accounts[0].id).toBe('fallback-2')
  })

  test('reorder emits INFO log and persists', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const plugin = await getPlugin()

    await executeCommand(plugin, 'claude-account', 'move-up fallback-2')
    const rec = findCommandsLog('account reordered')
    expect(rec).toBeDefined()
    expect(rec!.payload!.id).toBe('fallback-2')
    // No token in payload
    const payloadStr = JSON.stringify(rec!.payload)
    expect(payloadStr).not.toContain('refresh')
    expect(payloadStr).not.toContain('token')
    // Persisted
    const raw = await readConfigFile()
    expect(raw.accounts.map((a: any) => a.id)).toEqual([
      'fallback-2',
      'fallback-1',
      'fallback-3',
    ])
  })

  test('status emits no setting-change log', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const plugin = await getPlugin()

    await executeCommand(plugin, 'claude-account', '')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  test('retired custody syntax returns usage without touching the account file', async () => {
    const storage = baseStorage()
    await saveAccounts(storage, accountPath)
    const before = await readFile(accountPath, 'utf8')
    const beforeMtime = (await fs.stat(accountPath)).mtimeMs
    const plugin = await getPlugin()
    drainNotifications(0, 'ses_test')

    await executeCommand(plugin, 'claude-account', 'custody fallback-1 on')

    const notice = drainNotifications(0, 'ses_test').at(-1)
    expect(notice).toBeDefined()
    if (
      notice?.type !== 'open-dialog' ||
      notice.payload.command !== 'claude-account'
    )
      throw new Error('Expected legacy account guidance payload')
    const payload = notice.payload
    expect(payload.text).toContain('/claude-account claustrum')
    expect(payload.text).toContain('/claude-account local')
    expect(await readFile(accountPath, 'utf8')).toBe(before)
    expect((await fs.stat(accountPath)).mtimeMs).toBe(beforeMtime)
  })

  test('claustrum command gives scoped setup guidance without changing local storage', async () => {
    await saveAccounts(baseStorage(), accountPath)
    const plugin = await getPlugin()
    await plugin.auth.loader(
      async () => ({
        type: 'oauth',
        access: 'real-main-access',
        refresh: 'real-main-refresh',
        expires: Date.now() + 60_000,
      }),
      { models: {} },
    )
    const before = await readFile(accountPath, 'utf8')
    drainNotifications(0, 'ses_test')
    await executeCommand(plugin, 'claude-account', 'claustrum')
    const notice = drainNotifications(0, 'ses_test').at(-1)
    expect(notice).toBeDefined()
    if (
      notice?.type !== 'open-dialog' ||
      notice.payload.command !== 'claude-account'
    )
      throw new Error('Expected legacy account guidance payload')
    const payload = notice.payload
    expect(payload.text).toContain('setup')
    expect(await readFile(accountPath, 'utf8')).toBe(before)
  })

  test('does not retain a background interval unless the helper opts in', async () => {
    await saveAccounts(baseStorage(), accountPath)
    await getPlugin()
    expect(timerTracking.disabledIntervalCalls).toBe(1)
    expect(activeIntervals.size).toBe(0)

    await timerTracking.withTrackedInterval(async () => {
      await getPlugin({
        setInterval: trackedSetInterval,
        clearInterval: trackedClearInterval,
      })
      expect(activeIntervals.size).toBe(1)
    })
    expect(activeIntervals.size).toBe(0)
  })
})
