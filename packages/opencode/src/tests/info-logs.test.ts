import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  type LogTestRecord,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'

function createFallbackStorage(): AccountStorage {
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
    accounts: [],
  }
}

let tempConfigDir: string

async function useTempAccountFile(storage: AccountStorage) {
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true }).catch(() => {})
  }
  tempConfigDir = await mkdtemp(join(tmpdir(), 'anthropic-info-logs-test-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    tempConfigDir,
    'anthropic-auth.json',
  )
  await saveAccounts(storage)
}

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

let capturedRecords: LogTestRecord[] = []

beforeEach(() => {
  capturedRecords = []
  __setLogTestSink((record) => {
    capturedRecords.push(record)
  })
})

afterEach(async () => {
  __setLogTestSink(null)
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true }).catch(() => {})
  }
})

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

describe('setting-change INFO logs', () => {
  // -- dump ----------------------------------------------------------------

  test('dump on emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-dump', 'on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('dump changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await readConfigFile()
    expect(raw.dump?.enabled).toBe(true)
  })

  test('dump off emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-dump', 'off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('dump changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
    const raw = await readConfigFile()
    expect(raw.dump?.enabled).toBe(false)
  })

  test('dump status emits no setting-change info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-dump', '')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  // -- fast mode -----------------------------------------------------------

  test('fast on emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-fast', 'on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('fast mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await readConfigFile()
    expect(raw.claudeFast?.enabled).toBe(true)
  })

  test('fast off emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-fast', 'off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('fast mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  // -- routing -------------------------------------------------------------

  test('routing mode change emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-routing', 'fallback-first')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('routing mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ mode: 'fallback-first' })
    const raw = await readConfigFile()
    expect(raw.routing?.mode).toBe('fallback-first')
  })

  test('routing status emits no setting-change info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-routing', '')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  // -- cache 1h ------------------------------------------------------------

  test('cache on emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cache', 'on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cache enabled changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await readConfigFile()
    expect(raw.claudeCache?.enabled).toBe(true)
  })

  test('cache mode change emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cache', 'mode hybrid')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cache mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ mode: 'hybrid' })
    const raw = await readConfigFile()
    expect(raw.claudeCache?.mode).toBe('hybrid')
  })

  // -- killswitch ----------------------------------------------------------

  test('killswitch on emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-killswitch', 'on')
    const rec = findCommandsLog('killswitch changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await readConfigFile()
    expect(raw.killswitch?.enabled).toBe(true)
  })

  test('killswitch off emits info log after on', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    // Turn on first so off is a genuine change
    await executeCommand(plugin, 'claude-killswitch', 'on')
    capturedRecords = []
    await executeCommand(plugin, 'claude-killswitch', 'off')
    const rec = findCommandsLog('killswitch changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  test('killswitch set emits thresholds info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-killswitch', 'set main:3,8')
    const rec = findCommandsLog('killswitch thresholds changed')
    expect(rec).toBeDefined()
    expect(rec!.payload?.thresholds).toEqual({ five_hour: 3, seven_day: 8 })
    const raw = await readConfigFile()
    expect(raw.killswitch?.enabled).toBe(true)
    expect(raw.killswitch?.main?.five_hour).toBe(3)
    expect(raw.killswitch?.main?.seven_day).toBe(8)
  })

  test('killswitch status emits no setting-change info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-killswitch', '')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  // -- cachekeep -----------------------------------------------------------

  test('cachekeep window emits info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cachekeep', '09-17')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cachekeep schedule changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ schedule: '9-17' })
  })

  test('cachekeep always emits info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cachekeep', 'always')
    const rec = findCommandsLog('cachekeep schedule changed')
    expect(rec?.payload).toEqual({ schedule: 'always' })
  })

  test('cachekeep off emits info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cachekeep', 'off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cachekeep enabled changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  test('cachekeep subagents emits info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cachekeep', 'subagents on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cachekeep subagents changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ subagents: true })
  })

  // -- logging --------------------------------------------------------------

  test('logging level change emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-logging', 'debug')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('log level changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ level: 'debug' })
    const raw = await readConfigFile()
    expect(raw.logging?.level).toBe('debug')
  })

  test('logging status emits no setting-change info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-logging', '')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  test('logging trace level persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-logging', 'trace')
    const raw = await readConfigFile()
    expect(raw.logging?.level).toBe('trace')
  })

  test('logging getLogLevel reflects persisted level after command', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-logging', 'warn')
    const { getLogLevel: _getLogLevel } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(_getLogLevel()).toBe('warn')
  })

  // -- payload hygiene -----------------------------------------------------

  test('INFO log payload does not contain tokens or bearer strings', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    capturedRecords = []
    await executeCommand(plugin, 'claude-dump', 'on')
    const recs = capturedRecords.filter(
      (r) => r.level === 'info' && r.channel === 'commands',
    )
    for (const rec of recs) {
      const payload = rec.payload ?? {}
      for (const val of Object.values(payload)) {
        if (typeof val === 'string') {
          expect(val).not.toMatch(/^(Bearer |sk-|eyJ)/)
        }
      }
    }
  })

  // -- prime ---------------------------------------------------------------

  test('prime on emits info log and persists', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-prime', 'on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('prime changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await readConfigFile()
    expect(raw.prime?.enabled).toBe(true)
  })

  test('prime off after on emits info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    // Turn on first so off is a genuine change
    await executeCommand(plugin, 'claude-prime', 'on')
    capturedRecords = []
    await executeCommand(plugin, 'claude-prime', 'off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('prime changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  test('prime status emits no setting-change info log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-prime', '')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  test('repeated prime on emits only one setting-change log', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-prime', 'on')
    capturedRecords = []
    await executeCommand(plugin, 'claude-prime', 'on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })
})
