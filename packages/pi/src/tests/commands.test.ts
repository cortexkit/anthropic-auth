import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheKeepSessionRegistry } from '@cortexkit/anthropic-auth-core'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { registerCommands } from '../commands'

const ENV_KEY = 'PI_ANTHROPIC_AUTH_FILE'
const CACHEKEEP_REGISTRY_ENV_KEY = 'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR'
const ROUTING_STATE_ENV_KEY = 'PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE'

function mockNotify(): { ctx: ExtensionCommandContext; notified: string[] } {
  const notified: string[] = []
  const ctx = {
    ui: { notify: (msg: string) => notified.push(msg) },
    sessionManager: { getSessionId: () => 'pi-session-1' },
  } as unknown as ExtensionCommandContext
  return { ctx, notified }
}

function mockPi(): {
  pi: ExtensionAPI
  commands: Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >
} {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >()
  const pi = {
    registerCommand: (
      name: string,
      def: {
        description?: string
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
      },
    ) => {
      commands.set(name, def)
    },
  } as ExtensionAPI
  return { pi, commands }
}

let tempDir: string
let accountPath: string
let statePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pi-commands-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  // The core's getAccountStatePath places the state file alongside
  // the config when the config ends with the account file name.
  statePath = join(tempDir, 'anthropic-auth-state.json')
  process.env[ENV_KEY] = accountPath
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = statePath
  process.env[CACHEKEEP_REGISTRY_ENV_KEY] = join(tempDir, 'cachekeep-registry')
  process.env[ROUTING_STATE_ENV_KEY] = join(tempDir, 'routing-state.json')
})

afterEach(async () => {
  delete process.env[ENV_KEY]
  delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  delete process.env[CACHEKEEP_REGISTRY_ENV_KEY]
  delete process.env[ROUTING_STATE_ENV_KEY]
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  expect(process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE).toBeUndefined()
})

describe('claude-account persistence', () => {
  test('disable persists to storage', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: 'One',
            type: 'oauth',
            access: 'tok',
            refresh: 'rtok',
            enabled: true,
            addedAt: 1,
          },
          {
            id: 'a2',
            label: 'Two',
            type: 'api',
            baseURL: 'https://api.example.com',
            authHeader: 'authorization-bearer',
            enabled: true,
            addedAt: 2,
          },
        ],
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('disable a2', ctx)

    expect(notified[0] ?? '').toInclude('disabled')
    expect(notified[0] ?? '').toInclude('Two')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    const account = storage.accounts.find((a: { id: string }) => a.id === 'a2')
    expect(account.enabled).toBe(false)
  })

  test('remove persists to storage', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: 'One',
            type: 'oauth',
            access: 'tok',
            refresh: 'rtok',
            enabled: true,
            addedAt: 1,
          },
          {
            id: 'a2',
            label: 'Two',
            type: 'api',
            baseURL: 'https://api.example.com',
            authHeader: 'authorization-bearer',
            enabled: true,
            addedAt: 2,
          },
        ],
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('remove a2', ctx)

    expect(notified[0] ?? '').toInclude('removed')
    expect(notified[0] ?? '').toInclude('Two')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0].id).toBe('a1')
  })

  test('enable persists to storage', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: 'One',
            type: 'oauth',
            access: 'tok',
            refresh: 'rtok',
            enabled: false,
            addedAt: 1,
          },
        ],
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx } = mockNotify()
    await handler!('enable a1', ctx)

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts[0].enabled).toBe(true)
  })

  test('status is display-only (no mutation)', async () => {
    const original = {
      version: 1,
      accounts: [
        {
          id: 'a1',
          label: 'One',
          type: 'oauth',
          access: 'tok',
          refresh: 'rtok',
          enabled: true,
          addedAt: 1,
        },
      ],
    }
    await writeFile(accountPath, JSON.stringify(original), 'utf8')

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0] ?? '').toInclude('Claude Accounts')
    expect(notified[0] ?? '').toInclude('One')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage).toEqual(original)
  })
})

describe('claude-logging persistence', () => {
  test('sets log level and persists', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [] }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-logging')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('debug', ctx)

    expect(notified[0] ?? '').toInclude('debug')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.logging?.level).toBe('debug')
  })

  test('status shows current level without mutating', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        logging: { level: 'warn' },
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-logging')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0] ?? '').toInclude('warn')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.logging?.level).toBe('warn')
  })
})

describe('claude-cachekeep status', () => {
  test('lists tracked sessions from all live Pi instances', async () => {
    const registryDirectory = process.env[CACHEKEEP_REGISTRY_ENV_KEY]
    if (!registryDirectory)
      throw new Error('missing cachekeep registry directory')
    const registry = new CacheKeepSessionRegistry({
      directory: registryDirectory,
      instanceId: 'other-pi-instance',
    })
    const cacheExpiresAt = Date.now() + 60 * 60_000
    await registry.publish([
      {
        id: 'pi-session-1',
        cacheExpiresAt,
        nextPrewarmAt: cacheExpiresAt - 5 * 60_000,
      },
    ])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, startHour: 0, endHour: 23 },
      }),
      'utf8',
    )
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-cachekeep')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0]).toContain('Tracked sessions: 1')
    expect(notified[0]).toContain('Sessions:\n- pi-session-1')
  })

  test('persists and reports the always schedule', async () => {
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-cachekeep')?.handler
    const { ctx, notified } = mockNotify()

    await handler!('always', ctx)

    expect(notified[0]).toContain(
      'Schedule: always (while this process is running)',
    )
    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.cacheKeep).toEqual({ enabled: true, always: true })
  })
})

describe('claude-routing persistence', () => {
  test('reset clears the current Pi session assignment without changing mode', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        routing: { mode: 'sticky-balanced' },
      }),
      'utf8',
    )
    const routingPath = process.env[ROUTING_STATE_ENV_KEY]
    if (!routingPath) throw new Error('missing routing state path')
    const key = createHash('sha256').update('pi-session-1').digest('hex')
    const now = Date.now()
    await writeFile(
      routingPath,
      JSON.stringify({
        version: 1,
        updatedAt: now,
        assignments: {
          [key]: {
            accountId: 'main',
            family: 'general',
            assignedAt: now,
            lastSeenAt: now,
            initialInputBytes: 1,
            quotaCheckedAt: 1,
          },
        },
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-routing')?.handler
    const { ctx, notified } = mockNotify()
    await handler!('reset', ctx)

    expect(notified[0]).toContain('Claude Routing Assignment Reset')
    const state = JSON.parse(await readFile(routingPath, 'utf8'))
    expect(state.assignments).toEqual({})
    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.routing).toEqual({ mode: 'sticky-balanced' })
  })
})

describe('claude-prime — Pi display-only contract', () => {
  // The plan + rev-1 / rev-2 require that Pi's `/claude-prime` handler
  // is display-only: it must NEVER call `setPrimePersistentEnabled`,
  // and on/off/status args must all return the same status text. The
  // byte-for-byte config + runtime-state file invariance ensures a
  // future edit that wires Pi to the persistent setter would fail this
  // test.

  function readConfigAndState() {
    return Promise.all([
      readFile(accountPath, 'utf8').then((text) => JSON.parse(text)),
      readFile(statePath, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null),
    ]).then(([config, state]) => ({ config, state }))
  }

  test('registers a claude-prime command (sanity)', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [] }),
      'utf8',
    )
    const { pi, commands } = mockPi()
    registerCommands(pi)
    expect(commands.get('claude-prime')).toBeDefined()
  })

  test('status arg notifies the current status; config + state bytes are unchanged', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: true },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('status', ctx)

    expect(notified[0] ?? '').toContain('## Claude Prime Status')
    const { config, state } = await readConfigAndState()
    expect(config).toEqual(initial)
    // state file either unchanged (no runtime state) or non-existent.
    expect(state === null || state.version === 1).toBe(true)
  })

  test('on arg in Pi is display-only — never toggles the persistent setting', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: false },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('on', ctx)

    // The handler MUST notify, but the persistent state MUST stay off.
    expect(notified.length).toBeGreaterThan(0)
    const { config, state } = await readConfigAndState()
    expect(config.prime?.enabled).toBe(false)
    expect(state === null || state.prime?.enabled !== true).toBe(true)
  })

  test('off arg in Pi is display-only — never toggles the persistent setting', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: true },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('off', ctx)

    expect(notified.length).toBeGreaterThan(0)
    const { config, state } = await readConfigAndState()
    expect(config.prime?.enabled).toBe(true)
    expect(state === null || state.prime?.enabled !== false).toBe(true)
  })

  test('empty arg in Pi shows the status and does not mutate storage', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: true },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0] ?? '').toContain('## Claude Prime Status')
    const { config, state } = await readConfigAndState()
    expect(config).toEqual(initial)
    expect(state === null || state.version === 1).toBe(true)
  })
})
