import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  buildAccountList,
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

let tempDir: string
let accountPath: string

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
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-acct-cmd-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  await rm(tempDir, { recursive: true, force: true })
  mock.restore()
})

// ---------------------------------------------------------------------------
// parseAccountCommandAction
// ---------------------------------------------------------------------------
describe('parseAccountCommandAction', () => {
  test('bare command returns status', () => {
    expect(parseAccountCommandAction('')).toEqual({ type: 'status' })
  })

  test('enable with id', () => {
    expect(parseAccountCommandAction('enable fallback-1')).toEqual({
      type: 'enable',
      id: 'fallback-1',
    })
  })

  test('disable with id', () => {
    expect(parseAccountCommandAction('disable fallback-1')).toEqual({
      type: 'disable',
      id: 'fallback-1',
    })
  })

  test('remove with id', () => {
    expect(parseAccountCommandAction('remove fallback-1')).toEqual({
      type: 'remove',
      id: 'fallback-1',
    })
  })

  test('move-up with id', () => {
    expect(parseAccountCommandAction('move-up fallback-1')).toEqual({
      type: 'move-up',
      id: 'fallback-1',
    })
  })

  test('move-down with id', () => {
    expect(parseAccountCommandAction('move-down fallback-1')).toEqual({
      type: 'move-down',
      id: 'fallback-1',
    })
  })

  test('enable without id returns usage', () => {
    expect(parseAccountCommandAction('enable')).toEqual({ type: 'usage' })
  })

  test('garbage returns usage', () => {
    expect(parseAccountCommandAction('garbage')).toEqual({ type: 'usage' })
  })

  test('add-oauth-finish with code only (no label)', () => {
    expect(parseAccountCommandAction('add-oauth-finish abc123')).toEqual({
      type: 'add-oauth-finish',
      code: 'abc123',
    })
  })

  test('add-oauth-finish with --label', () => {
    expect(
      parseAccountCommandAction('add-oauth-finish abc123 --label work'),
    ).toEqual({
      type: 'add-oauth-finish',
      code: 'abc123',
      label: 'work',
    })
  })

  test('add-oauth-finish --label with multi-word label', () => {
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

  test('no main quota returns null percent', () => {
    const storage = baseStorage()
    storage.quota!.mainQuota = undefined
    const list = buildAccountList(storage)
    expect(list[0]!.quotaPercent).toBeNull()
  })

  test('no label falls back to id', () => {
    const storage: AccountStorage = {
      version: 1,
      accounts: [{ id: 'abc', type: 'oauth', refresh: 'x' }],
    }
    const list = buildAccountList(storage)
    expect(list[1]!.label).toBe('abc')
  })
})

// ---------------------------------------------------------------------------
// executeAccountCommand — status
// ---------------------------------------------------------------------------
describe('executeAccountCommand status', () => {
  test('bare status returns account list in text', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({ argumentsText: '', storage })
    expect(result.text).toContain('## Claude Accounts')
    expect(result.text).toContain('OpenCode anthropic')
    expect(result.text).toContain('Work account')
    expect(result.text).toContain('Personal account')
    expect(result.text).toContain('Disabled account')
    expect(result.text).toContain('42%')
    expect(result.text).toContain('(disabled)')
  })

  test('usage returns usage text', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({ argumentsText: 'garbage', storage })
    expect(result.text).toContain('Usage:')
    expect(result.text).toContain('/claude-account enable')
  })
})

// ---------------------------------------------------------------------------
// executeAccountCommand — enable / disable
// ---------------------------------------------------------------------------
describe('executeAccountCommand enable/disable', () => {
  test('enable sets enabled flag on result', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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

  test('disable sets enabled flag on result', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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

  test('enable main is rejected', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
      argumentsText: 'enable main',
      storage,
    })
    expect(result.text).toContain('Cannot enable the main account')
    expect(result.updated).toBeUndefined()
  })

  test('disable main is rejected', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
      argumentsText: 'disable main',
      storage,
    })
    expect(result.text).toContain('Cannot disable the main account')
    expect(result.updated).toBeUndefined()
  })

  test('enable non-existent returns not found', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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
  test('remove returns updated', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
      argumentsText: 'remove fallback-1',
      storage,
    })
    expect(result.text).toContain('removed')
    expect(result.updated).toEqual({
      id: 'fallback-1',
      action: 'remove',
    })
  })

  test('remove main is rejected', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
      argumentsText: 'remove main',
      storage,
    })
    expect(result.text).toContain('Cannot remove the main account')
    expect(result.updated).toBeUndefined()
  })

  test('remove non-existent returns not found', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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
  test('move-up returns updated with new order', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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

  test('move-up first item is no-op', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
      argumentsText: 'move-up fallback-1',
      storage,
    })
    expect(result.text).toContain('already first')
    expect(result.updated).toBeUndefined()
  })

  test('move-down returns updated with new order', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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

  test('move-down last item is no-op', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
      argumentsText: 'move-down fallback-3',
      storage,
    })
    expect(result.text).toContain('already last')
    expect(result.updated).toBeUndefined()
  })

  test('move-up non-existent returns not found', () => {
    const storage = baseStorage()
    const result = executeAccountCommand({
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

  async function getPlugin() {
    return (await AnthropicAuthPlugin({
      // @ts-expect-error: minimal mock for testing
      client: createMockClient(),
    })) as Promise<any>
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
})
