import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type ClaustrumEnrollmentClient,
  ClaustrumScopedCredentialError,
  createNativeAccountRuntime,
  type ProviderAccountUuid,
  readNativeMigrationJournal,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { runSetupCommand } from '../setup/command.ts'
import { resolveNativeSetupPaths } from '../setup/native-paths.ts'
import type { CommandRunner, ProcessFence } from '../setup/types.ts'

const testDirs: string[] = []
afterEach(async () => {
  for (const d of testDirs.splice(0)) {
    await rm(d, { recursive: true, force: true })
  }
})

function createTestFence(
  running: Array<{ pid: number; command: string }> = [],
): ProcessFence {
  return {
    async listRunningHosts() {
      return running
    },
  }
}

function createMockRunner(
  handlers: Record<
    string,
    (args: string[]) => { exitCode: number; stdout: string; stderr: string }
  > = {},
): CommandRunner {
  return {
    async run(command, args) {
      const handler = handlers[command]
      if (handler) return handler(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

describe('setup wizard command', () => {
  test('aborts with error when OpenCode or Pi processes are running', async () => {
    const fence = createTestFence([{ pid: 1234, command: 'opencode serve' }])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 0, stdout: '0.86.1\n', stderr: '' }),
      ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
    })

    const code = await runSetupCommand(['--yes'], { fence, runner })
    expect(code).toBe(1)
  })

  test('dry run reports planned actions and does not modify disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-dry-run-'))
    testDirs.push(root)

    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'unavailable-subc-connection.json',
      ),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    }

    const fence = createTestFence([])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 0, stdout: '0.86.1\n', stderr: '' }),
      ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
    })

    const code = await runSetupCommand(
      ['--yes', '--dry-run', '--no-claustrum'],
      { fence, runner, env },
    )
    expect(code).toBe(0)

    // Verify no files were created
    const fs = await import('node:fs')
    expect(
      fs.existsSync(join(root, '.config', 'opencode', 'opencode.jsonc')),
    ).toBe(false)
    expect(
      fs.existsSync(join(root, '.local', 'share', 'opencode', 'auth.json')),
    ).toBe(false)
  })

  test('aborts when neither OpenCode nor Pi is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-no-hosts-'))
    testDirs.push(root)

    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'unavailable-subc-connection.json',
      ),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
    }

    const fence = createTestFence([])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      ck: () => ({ exitCode: 0, stdout: '0.20.8\n', stderr: '' }),
    })

    const code = await runSetupCommand(['--yes'], { fence, runner, env })
    expect(code).toBe(1)
  })

  test('configures OpenCode with pinned plugin and TUI entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'setup-opencode-'))
    testDirs.push(root)

    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
        root,
        'unavailable-subc-connection.json',
      ),
      XDG_CONFIG_HOME: join(root, '.config'),
      XDG_DATA_HOME: join(root, '.local', 'share'),
      PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
    }

    const configDir = join(root, '.config', 'opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'opencode.jsonc'),
      '{\n  "plugin": []\n}\n',
      'utf8',
    )

    const fence = createTestFence([])
    const runner = createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      ck: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
    })

    const code = await runSetupCommand(['--yes', '--no-claustrum'], {
      fence,
      runner,
      env,
    })
    expect(code).toBe(0)

    const updatedConfig = await readFile(
      join(configDir, 'opencode.jsonc'),
      'utf8',
    )
    expect(updatedConfig).toContain('@cortexkit/opencode-anthropic-auth@')

    const tuiConfig = await readFile(join(configDir, 'tui.jsonc'), 'utf8')
    expect(tuiConfig).toContain('@cortexkit/opencode-anthropic-auth@')
    const plan = await resolveNativeSetupPaths('opencode', env)
    const journal = await readNativeMigrationJournal(plan.paths)
    expect(journal?.phase).toBe('retired')
  })
})

test('executes end-to-end Claustrum setup for OpenCode with mock ck and daemon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-claustrum-e2e-'))
  testDirs.push(root)

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'unavailable-subc-connection.json',
    ),
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
  }

  const configDir = join(root, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'opencode.jsonc'),
    '{\n  "plugin": []\n}\n',
    'utf8',
  )

  const row = {
    id: 'oauth:anthropic',
    accountId: 'provider-main',
    categories: ['anthropic-native'],
    credentialType: 'oauth',
    refreshAdapter: 'anthropic',
    state: 'active',
    operations: ['read'],
    recordVersion: 1,
  }

  const calls: string[][] = []
  const fence = createTestFence([])
  const runner = createMockRunner({
    opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
    pi: () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
    ck: (args) => {
      calls.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })

  // Setup paths for mock enrollment
  const paths = {
    tokenPath: join(
      root,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'opencode-enrollment.json',
    ),
    statePath: join(
      root,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'opencode-enrollment-state.json',
    ),
  }
  await mkdir(join(root, '.local', 'state', 'cortexkit', 'anthropic-auth'), {
    recursive: true,
  })
  await writeFile(
    paths.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )

  const scopedClient = {
    listScoped: async () => ({ view: 'v', rows: [row as any] }),
    getScoped: async () => ({
      material: 'mock-access',
      credentialId: row.id,
      accountId: row.accountId,
      recordVersion: 1,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  } as any

  const { setupClaustrumForHost } = await import('../setup/claustrum.ts')
  const res = await setupClaustrumForHost('opencode', {
    paths,
    runner,
    env,
    scopedClient,
  })

  expect(res.ok).toBe(true)
  expect(res.discoveredAccounts).toHaveLength(1)
  expect(res.discoveredAccounts[0]).toEqual({
    credentialId: 'oauth:anthropic',
    accountId: 'provider-main',
  })

  // Verify ck was called for grant
  expect(
    calls.some(
      (args) => args.includes('grant') && args.includes('anthropic-native'),
    ),
  ).toBe(true)

  // Verify tombstone writing
  const { writeOpenCodeTombstoneAuth } = await import('../setup/activation.ts')
  const authPath = join(root, '.local', 'share', 'opencode', 'auth.json')
  await writeOpenCodeTombstoneAuth({ authPath, fence })

  const authContent = JSON.parse(await readFile(authPath, 'utf8'))
  expect(authContent.anthropic).toEqual({
    type: 'oauth',
    access: '',
    refresh: 'claustrum-tombstone:v1:anthropic',
    expires: 0,
  })
})

test('approved enrollment never opens a live daemon connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-claustrum-nodaemon-'))
  testDirs.push(root)

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'unavailable-subc-connection.json',
    ),
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    // Hostile daemon pointers: an approved token must not require any
    // enrollment connection, so these must never be touched.
    XDG_RUNTIME_DIR: join(root, 'nonexistent-runtime'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'nonexistent-subc.json'),
    PI_CODING_AGENT_DIR: join(root, 'nonexistent-pi'),
  }

  const paths = {
    tokenPath: join(
      root,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'opencode-enrollment.json',
    ),
    statePath: join(
      root,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'opencode-enrollment-state.json',
    ),
  }
  await mkdir(join(root, '.local', 'state', 'cortexkit', 'anthropic-auth'), {
    recursive: true,
  })
  await writeFile(
    paths.tokenPath,
    JSON.stringify({ token: '03'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )

  const row = {
    id: 'oauth:anthropic',
    accountId: 'provider-main',
    categories: ['anthropic-native'],
    credentialType: 'oauth',
    refreshAdapter: 'anthropic',
    state: 'active',
    operations: ['read'],
    recordVersion: 1,
  }
  const scopedClient = {
    listScoped: async () => ({ view: 'v', rows: [row as any] }),
    getScoped: async () => ({
      material: 'mock-access',
      credentialId: row.id,
      accountId: row.accountId,
      recordVersion: 1,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  } as any
  const runner = createMockRunner({
    ck: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  })

  const { setupClaustrumForHost } = await import('../setup/claustrum.ts')
  const res = await setupClaustrumForHost('opencode', {
    paths,
    runner,
    env,
    scopedClient,
  })
  expect(res.ok).toBe(true)
  expect(res.discoveredAccounts).toHaveLength(1)
})

test('executes Pi Claustrum setup: removes local OAuth and commits scoped roster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-pi-claustrum-'))
  testDirs.push(root)

  const agentDir = join(root, '.pi', 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(agentDir, 'auth.json'),
    JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: 'old-access',
        refresh: 'old-refresh',
      },
      openai: { type: 'api_key', key: 'keep-openai' },
    }),
    'utf8',
  )

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'unavailable-subc-connection.json',
    ),
    PI_CODING_AGENT_DIR: agentDir,
  }

  const row = {
    id: 'oauth:anthropic',
    accountId: 'provider-main',
    categories: ['anthropic-native'],
    credentialType: 'oauth',
    refreshAdapter: 'anthropic',
    state: 'active',
    operations: ['read'],
    recordVersion: 1,
  }

  const runner = createMockRunner({
    ck: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  })

  const paths = {
    tokenPath: join(
      root,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'pi-enrollment.json',
    ),
    statePath: join(
      root,
      '.local',
      'state',
      'cortexkit',
      'anthropic-auth',
      'pi-enrollment-state.json',
    ),
  }
  await mkdir(join(root, '.local', 'state', 'cortexkit', 'anthropic-auth'), {
    recursive: true,
  })
  await writeFile(
    paths.tokenPath,
    JSON.stringify({ token: '02'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )

  const scopedClient = {
    listScoped: async () => ({ view: 'v', rows: [row as any] }),
    getScoped: async () => ({
      material: 'mock-access',
      credentialId: row.id,
      accountId: row.accountId,
      recordVersion: 1,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  } as any

  const { cleanPiLocalAnthropicAuth } = await import('../setup/pi.ts')
  const cleaned = await cleanPiLocalAnthropicAuth(env)
  expect(cleaned).toBe(true)

  // Verify openai auth was preserved, anthropic was removed
  const authAfter = JSON.parse(
    await readFile(join(agentDir, 'auth.json'), 'utf8'),
  )
  expect(authAfter.anthropic).toBeUndefined()
  expect(authAfter.openai).toEqual({ type: 'api_key', key: 'keep-openai' })

  const { setupClaustrumForHost } = await import('../setup/claustrum.ts')
  const res = await setupClaustrumForHost('pi', {
    paths,
    runner,
    env,
    scopedClient,
  })

  expect(res.ok).toBe(true)
  expect(res.discoveredAccounts).toHaveLength(1)

  // Verify pi account storage was created with scoped roster
  const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
  const piStorage = await loadAccounts(join(agentDir, 'anthropic-auth.json'))
  expect(piStorage?.claustrum?.mode).toBe('claustrum')
  expect(piStorage?.claustrum?.scopedRoster).toBe(true)
  expect(piStorage?.claustrum?.primaryAccount?.credentialId).toBe(
    'oauth:anthropic',
  )
})

async function enrollmentSetupFixture(
  prefix: string,
  host: 'opencode' | 'pi' = 'opencode',
) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  testDirs.push(root)
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'unavailable-subc-connection.json',
    ),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    // Pi path resolution uses its explicit agent-dir variable, not env.HOME.
    PI_AGENT_DIR: join(root, 'pi-agent'),
  }
  const paths = {
    tokenPath: join(root, 'state', `${host}-enrollment.json`),
    statePath: join(root, 'state', `${host}-enrollment-state.json`),
  }
  await mkdir(join(root, 'state'), { recursive: true })
  const approved: string[][] = []
  const runner = createMockRunner({
    ck: (args) => {
      if (args.includes('approve')) approved.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  const row = {
    id: 'oauth:anthropic',
    accountId: 'provider-main',
    categories: ['anthropic-native'],
    credentialType: 'oauth',
    refreshAdapter: 'anthropic',
    state: 'active',
    operations: ['read'],
    recordVersion: 1,
  }
  const scopedClient = {
    listScoped: async () => ({ view: 'v1', rows: [row] }),
    getScoped: async () => ({
      material: 'mock-access',
      credentialId: row.id,
      accountId: row.accountId,
      recordVersion: 1,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  return {
    paths,
    approved,
    row,
    proposedName: `anthropic-auth-${host}`,
    async run(enrollmentClient: ClaustrumEnrollmentClient) {
      const { setupClaustrumForHost } = await import('../setup/claustrum.ts')
      return setupClaustrumForHost(host, {
        env,
        paths,
        runner,
        enrollmentClient,
        scopedClient: scopedClient as never,
      })
    },
  }
}

test.each(['opencode', 'pi'] as const)(
  'explicit setup for %s resumes a persisted secret before propose and completes scoped enrollment',
  async (host) => {
    const { paths, approved, row, proposedName, run } =
      await enrollmentSetupFixture('setup-resume-enrollment-', host)
    const requestSecret = '01'.repeat(32)
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase: 'pending',
        proposedName,
        requestSecret,
        createdAt: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    let proposes = 0
    let polls = 0
    const result = await run({
      enrollPropose: async () => {
        proposes++
        const persisted = JSON.parse(await readFile(paths.statePath, 'utf8'))
        expect(persisted.requestSecret).toBe(requestSecret)
        return { requestId: 'resumed-request' }
      },
      enrollPoll: async () => {
        polls++
        return polls === 1
          ? { status: 'pending' as const }
          : {
              status: 'approved' as const,
              name: proposedName,
              token: '02'.repeat(32),
              tokenGeneration: 1,
            }
      },
    })
    expect(result.ok).toBe(true)
    expect(result.discoveredAccounts).toEqual([
      { credentialId: row.id, accountId: row.accountId },
    ])
    expect(proposes).toBe(1)
    expect(polls).toBe(2)
    expect(approved).toHaveLength(1)
    expect(approved[0]).toContain('resumed-request')
    const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(state.phase).toBe('approved')
    expect(JSON.stringify(state)).not.toContain(requestSecret)
  },
)

test.each(['pending', 'blocked'] as const)(
  'explicit setup replaces one superseded %s request without approving its dead id',
  async (phase) => {
    const { paths, approved, run } = await enrollmentSetupFixture(
      'setup-expired-enrollment-',
    )
    const expiredSecret = '11'.repeat(32)
    await writeFile(
      paths.statePath,
      JSON.stringify({
        version: 1,
        phase,
        proposedName: 'anthropic-auth-opencode',
        ...(phase === 'pending' && {
          requestSecret: expiredSecret,
          requestId: 'expired-id',
          createdAt: 1,
        }),
        ...(phase === 'blocked' && { errorCode: 'superseded' }),
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    let proposes = 0
    const polled: string[] = []
    const result = await run({
      enrollPropose: async () => {
        proposes++
        const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
        expect(state.requestSecret).not.toBe(expiredSecret)
        return { requestId: 'fresh-id' }
      },
      enrollPoll: async ({ requestId }) => {
        polled.push(requestId)
        if (requestId === 'expired-id') {
          throw new ClaustrumScopedCredentialError(
            'superseded',
            'transient',
            'retry',
          )
        }
        return polled.filter((id) => id === 'fresh-id').length === 1
          ? { status: 'pending' as const }
          : {
              status: 'approved' as const,
              name: 'anthropic-auth-opencode',
              token: '22'.repeat(32),
              tokenGeneration: 1,
            }
      },
    })
    expect(result.ok).toBe(true)
    expect(proposes).toBe(1)
    expect(polled).toEqual([
      ...(phase === 'pending' ? ['expired-id'] : []),
      'fresh-id',
      'fresh-id',
    ])
    expect(approved).toHaveLength(1)
    expect(approved[0]).toContain('fresh-id')
    expect(approved[0]).not.toContain('expired-id')
    const state = JSON.parse(await readFile(paths.statePath, 'utf8'))
    expect(state.phase).toBe('approved')
    expect(JSON.stringify(state)).not.toContain(expiredSecret)
  },
)

test('explicit offline recovery login is performed before setup reports completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-offline-login-'))
  testDirs.push(root)
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    PI_CODING_AGENT_DIR: join(root, 'absent-pi'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'absent-connection',
    ),
  }
  const plan = await resolveNativeSetupPaths('opencode', env)
  await mkdir(dirname(plan.hostAuthPath), { recursive: true, mode: 0o700 })
  const oldAuth = JSON.stringify({
    anthropic: {
      type: 'oauth',
      access: 'sk-ant-oat01-old-unidentified',
      refresh: 'old-refresh',
      expires: Date.now() + 24 * 60 * 60_000,
    },
  })
  await writeFile(plan.hostAuthPath, oldAuth, { mode: 0o600 })
  await expect(
    runNativeMigration({
      ...plan,
      env,
      processFence: async () => {},
      requestVaultActivation: true,
      removePiAnthropicAuth: false,
    }),
  ).rejects.toThrow('setup --login --no-claustrum')
  expect(await readFile(plan.hostAuthPath, 'utf8')).toBe(oldAuth)
  expect(await readNativeMigrationJournal(plan.paths)).toBeUndefined()
  let logins = 0
  const options = {
    env,
    fence: createTestFence(),
    runner: createMockRunner({
      opencode: () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      pi: () => ({ exitCode: 1, stdout: '', stderr: '' }),
      ck: () => ({ exitCode: 1, stdout: '', stderr: '' }),
    }),
    localLogin: async () => {
      logins++
      return {
        accountIdentity: 'aabbccdd-1122-3344-5566-778899001122',
        credential: {
          type: 'oauth' as const,
          access: 'sk-ant-oat01-fresh-main',
          refresh: 'fresh-refresh',
          expires: Date.now() + 24 * 60 * 60_000,
        },
      }
    },
  }
  expect(
    await runSetupCommand(['--yes', '--no-claustrum', '--login'], options),
  ).toBe(0)
  expect(logins).toBe(1)
  const runtime = createNativeAccountRuntime({
    paths: plan.paths,
    host: 'opencode',
    local: {
      refreshToken: async () => {
        throw new Error('Unexpected token refresh after fresh sign-in')
      },
      resolveIdentity: async (access) => {
        expect(access).toBe('sk-ant-oat01-fresh-main')
        return {
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
          accountUuid:
            'aabbccdd-1122-3344-5566-778899001122' as ProviderAccountUuid,
        }
      },
    },
  })
  try {
    const snapshot = await runtime.read()
    expect(
      snapshot.accounts.find((account) => account.id === 'main')
        ?.accountIdentity,
    ).toBe('aabbccdd-1122-3344-5566-778899001122')
    expect((await readNativeMigrationJournal(plan.paths))?.phase).toBe(
      'retired',
    )
    const authorized = await runtime.authorizeLocal('main')
    expect(authorized).toMatchObject({ status: 'usable' })
    if (authorized.status !== 'usable')
      throw new Error('Fresh login did not authorize')
    expect(authorized.access).toBe('sk-ant-oat01-fresh-main')
    expect(authorized.subject.binding.identity).toBe(
      'aabbccdd-1122-3344-5566-778899001122',
    )
  } finally {
    runtime.close()
  }
})
