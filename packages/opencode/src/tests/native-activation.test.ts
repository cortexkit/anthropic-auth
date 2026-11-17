import { expect, spyOn } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createNativeAccountRuntime,
  disconnectNativeVaultForHost,
  type NativeCustodyInventory,
  nativeMigrationAuthorityPhase,
  nativePiAuthSlotPaths,
  openNativePiAuthSlot,
  readNativeEnrollmentMode,
  readNativeMigrationJournal,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'

import { runSetupCommand } from '../setup/command.ts'
import { activateNativeVaultForHost } from '../setup/native-activation.ts'
import { migrateNativeLocalForHost } from '../setup/native-local.ts'
import { resolveNativeSetupPaths } from '../setup/native-paths.ts'
import type {
  CommandRunner,
  HarnessKind,
  ProcessFence,
} from '../setup/types.ts'

const { test, deferCleanup } = createTestLifetimeSuite()

const MAIN_IDENTITY = '11111111-2222-4333-8444-555555555555'
const OTHER_PROVIDER = { type: 'api', key: 'synthetic-unrelated-provider' }
const INVENTORY: NativeCustodyInventory = {
  view: 'synthetic-view',
  skipped: [],
  credentials: [
    {
      credentialId: 'oauth:anthropic',
      credentialType: 'oauth',
      accountIdentity: MAIN_IDENTITY,
      state: 'active',
    },
  ],
}

/**
 * A private synthetic home: host config, enrollment and pool files all live in
 * it. The process fence, ck runner, enrollment client and vault inventory are
 * injected, so no live host, daemon or vault is used.
 */
async function fixture(host: HarnessKind, running: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'native-setup-activation-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, '.config'),
    XDG_DATA_HOME: join(root, '.local', 'share'),
    XDG_STATE_HOME: join(root, '.local', 'state'),
    PI_CODING_AGENT_DIR: join(root, '.pi', 'agent'),
    [`${host.toUpperCase()}_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE`]: join(
      root,
      'enrollment',
      `${host}.json`,
    ),
  }
  const paths = await resolveNativeSetupPaths(host, env)
  const calls: string[] = []
  let approved = false
  const runner: CommandRunner = {
    run: async (_command, args) => {
      calls.push(args.slice(0, 3).join(' '))
      if (args.includes('approve')) approved = true
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  const fence: ProcessFence = {
    listRunningHosts: async () =>
      running.map((command, index) => ({ pid: 100 + index, command })),
  }
  const options = {
    env,
    runner,
    fence,
    removePiAnthropicAuth: false,
    paths,
    discover: async () => INVENTORY,
    enrollment: {
      paths: {
        tokenPath: join(root, 'enrollment', `${host}.json`),
        statePath: join(root, 'enrollment', `${host}-state.json`),
      },
      client: {
        enrollPropose: async () => {
          calls.push('propose')
          return { requestId: 'synthetic-request-id' }
        },
        enrollPoll: async () => {
          calls.push('poll')
          return approved
            ? {
                status: 'approved' as const,
                name: `anthropic-auth-${host}`,
                token: 'c'.repeat(64),
                tokenGeneration: 1,
              }
            : { status: 'pending' as const }
        },
      },
    },
  }
  return {
    root,
    paths,
    calls,
    options,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function writeHostAuth(path: string, anthropic?: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    JSON.stringify({
      ...(anthropic ? { anthropic } : {}),
      other: OTHER_PROVIDER,
    }),
    { mode: 0o600 },
  )
}

test('a fresh OpenCode install enrolls and discovers vault accounts without creating local authority or changing host authentication', async () => {
  const f = await fixture('opencode')
  await writeHostAuth(f.paths.hostAuthPath)
  expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
    'committed',
  )
  expect(f.calls).toEqual([
    'propose',
    'poll',
    'auth enroll approve',
    'poll',
    'auth grant --principal',
  ])
  expect(await readNativeMigrationJournal(f.paths.paths)).toBeUndefined()
  const runtime = createNativeAccountRuntime({
    paths: f.paths.paths,
    host: 'opencode',
    vault: { env: f.options.env },
  })
  deferCleanup(() => runtime.close())
  expect((await runtime.read()).accounts).toMatchObject([
    { id: 'main', source: 'vault', accountIdentity: MAIN_IDENTITY },
  ])
  expect(JSON.parse(await readFile(f.paths.hostAuthPath, 'utf8'))).toEqual({
    other: OTHER_PROVIDER,
  })
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} activation and the empty-vault remedy use the approved principal`, async () => {
    const f = await fixture(host)
    const grants: string[][] = []
    const run = f.options.runner.run
    f.options.runner.run = async (command, args, options) => {
      if (args.includes('grant')) grants.push(args)
      return run(command, args, options)
    }
    f.options.enrollment.client.enrollPoll = async () => ({
      status: 'approved',
      name: `anthropic-auth-${host}-v2`,
      token: 'c'.repeat(64),
      tokenGeneration: 1,
    })
    f.options.discover = async () => ({
      view: 'synthetic-view',
      credentials: [],
      skipped: [],
      grantReach: { grants: 0, tuples: [] },
    })
    await expect(activateNativeVaultForHost(host, f.options)).rejects.toThrow(
      `Run ck auth grant --principal enrolled:anthropic-auth-${host}-v2 --selector-kind category --selector anthropic-native --operation read, then rerun setup.`,
    )
    expect(grants).toEqual([
      [
        'auth',
        'grant',
        '--principal',
        `enrolled:anthropic-auth-${host}-v2`,
        '--selector-kind',
        'category',
        '--selector',
        'anthropic-native',
        '--operation',
        'read',
      ],
    ])
  })
}

test('a retired local pool is activated without rerunning its migration', async () => {
  const f = await fixture('opencode')
  await writeHostAuth(f.paths.hostAuthPath)
  await runNativeMigration({
    paths: f.paths.paths,
    legacyConfigPath: f.paths.legacyConfigPath,
    legacyStatePath: f.paths.legacyStatePath,
    host: 'opencode',
    hostAuthPath: f.paths.hostAuthPath,
    routingSourcePath: f.paths.routingSourcePath,
    routingDestinationPath: f.paths.routingDestinationPath,
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  expect(
    nativeMigrationAuthorityPhase(
      await readNativeMigrationJournal(f.paths.paths),
    ),
  ).toBe('retired')
  const files = [
    f.paths.paths.config,
    f.paths.paths.state,
    f.paths.paths.runtime,
    f.paths.paths.journal,
    f.paths.hostAuthPath,
  ]
  const bytes = async () =>
    Promise.all(
      files.map((path) =>
        readFile(path).catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
          )
            return undefined
          throw error
        }),
      ),
    )
  const before = await bytes()
  expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
    'committed',
  )
  expect(await bytes()).toEqual(before)
})

test('environment, running-host and Pi consent fences refuse before enrollment or any file write', async () => {
  const cases: Array<{
    host: HarnessKind
    running?: string[]
    env?: NodeJS.ProcessEnv
    anthropic?: unknown
    consent?: boolean
    error: Record<string, unknown>
  }> = [
    {
      host: 'opencode',
      env: { OPENCODE_AUTH_CONTENT: '{}' },
      error: { code: 'auth-content-refused' },
    },
    {
      host: 'opencode',
      running: ['opencode serve'],
      error: { name: 'ProcessFenceViolationError' },
    },
    {
      host: 'pi',
      anthropic: { type: 'api_key', key: 'synthetic-pi-api-key' },
      error: { code: 'consent-required' },
    },
    {
      host: 'pi',
      anthropic: {
        type: 'oauth',
        access: 'synthetic-pi-access',
        refresh: 'synthetic-pi-refresh',
        expires: 1,
      },
      error: { code: 'consent-required' },
    },
  ]
  for (const item of cases) {
    const f = await fixture(item.host, item.running)
    await writeHostAuth(f.paths.hostAuthPath, item.anthropic)
    const host = await readFile(f.paths.hostAuthPath, 'utf8')
    await expect(
      activateNativeVaultForHost(item.host, {
        ...f.options,
        env: { ...f.options.env, ...item.env },
        removePiAnthropicAuth: item.consent ?? false,
      }),
    ).rejects.toMatchObject(item.error)
    expect(f.calls).toEqual([])
    expect(await readFile(f.paths.hostAuthPath, 'utf8')).toBe(host)
    expect(await readNativeMigrationJournal(f.paths.paths)).toBeUndefined()
    const entries = await readdir(f.root)
    expect(entries.includes('enrollment')).toBe(false)
  }
})

test('vault enrollment ignores an unverified legacy main and preserves all legacy credential bytes', async () => {
  const f = await fixture('opencode')
  await mkdir(dirname(f.paths.legacyConfigPath), {
    recursive: true,
    mode: 0o700,
  })
  const config = JSON.stringify({
    version: 1,
    accounts: [],
    mainAccountId: 'legacy-main',
  })
  const state = JSON.stringify({ main: {} })
  await writeFile(f.paths.legacyConfigPath, config, { mode: 0o600 })
  await writeFile(f.paths.legacyStatePath, state, { mode: 0o600 })
  await writeHostAuth(f.paths.hostAuthPath, {
    type: 'oauth',
    access: 'synthetic-unverified-main-access',
    refresh: 'synthetic-unverified-main-refresh',
    expires: Date.now() + 3_600_000,
  })
  const auth = await readFile(f.paths.hostAuthPath, 'utf8')
  expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
    'committed',
  )
  expect(await readNativeMigrationJournal(f.paths.paths)).toBeUndefined()
  expect(await readFile(f.paths.legacyConfigPath, 'utf8')).toBe(config)
  expect(await readFile(f.paths.legacyStatePath, 'utf8')).toBe(state)
  expect(await readFile(f.paths.hostAuthPath, 'utf8')).toBe(auth)
  for (const path of [
    f.paths.paths.config,
    f.paths.paths.state,
    f.paths.paths.runtime,
    f.paths.paths.roster,
  ]) {
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

test('vault setup never reads invalid local recovery files and never changes an existing host login', async () => {
  const f = await fixture('opencode')
  await writeHostAuth(f.paths.hostAuthPath, {
    type: 'api',
    key: 'synthetic-existing-host-key',
  })
  const files = [
    ...new Set([
      f.paths.legacyConfigPath,
      f.paths.legacyStatePath,
      f.paths.paths.config,
      f.paths.paths.state,
      f.paths.paths.runtime,
      f.paths.paths.journal,
      f.paths.paths.roster,
      f.paths.routingDestinationPath,
    ]),
  ]
  for (const path of files) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, 'synthetic-invalid-local-recovery-data', {
      mode: 0o600,
    })
  }
  const bytes = () =>
    Promise.all([...files, f.paths.hostAuthPath].map((path) => readFile(path)))
  const before = await bytes()
  expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
    'committed',
  )
  expect(await bytes()).toEqual(before)
  expect(await activateNativeVaultForHost('opencode', f.options)).toBe(
    'already-vault',
  )
  expect(await bytes()).toEqual(before)
})

test('combined local-login and vault flags refuse before detection or any file change', async () => {
  const f = await fixture('opencode')
  await writeHostAuth(f.paths.hostAuthPath, {
    type: 'oauth',
    access: 'synthetic-host-access',
    refresh: 'synthetic-host-refresh',
    expires: 1,
  })
  const before = await readFile(f.paths.hostAuthPath)
  let detections = 0
  expect(
    await runSetupCommand(['--yes', '--login', '--claustrum'], {
      env: f.options.env,
      fs: {
        exists() {
          detections++
          throw new Error('Detection must not run')
        },
        isDirectory() {
          detections++
          throw new Error('Detection must not run')
        },
        isFile() {
          detections++
          throw new Error('Detection must not run')
        },
        isExecutable() {
          detections++
          throw new Error('Detection must not run')
        },
        readText() {
          detections++
          throw new Error('Detection must not run')
        },
        realpath() {
          detections++
          throw new Error('Detection must not run')
        },
      },
    }),
  ).toBe(1)
  expect(detections).toBe(0)
  expect(await readFile(f.paths.hostAuthPath)).toEqual(before)
  expect(await readdir(f.root)).not.toContain('enrollment')
})

test('an enrolled host refuses local recovery before reading files or starting login', async () => {
  const f = await fixture('opencode')
  const token = f.options.enrollment.paths.tokenPath
  await mkdir(dirname(token), { recursive: true, mode: 0o700 })
  await writeFile(
    token,
    JSON.stringify({ token: 'c'.repeat(64), token_generation: 1 }),
    { mode: 0o600 },
  )
  const files = [
    ...new Set([
      f.paths.paths.config,
      f.paths.paths.state,
      f.paths.paths.runtime,
      f.paths.paths.journal,
      f.paths.legacyConfigPath,
      f.paths.legacyStatePath,
      f.paths.hostAuthPath,
      token,
    ]),
  ]
  for (const path of files.filter((path) => path !== token)) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, 'synthetic-invalid-local-recovery-data', {
      mode: 0o600,
    })
  }
  const bytes = () => Promise.all(files.map((path) => readFile(path)))
  const before = await bytes()
  let logins = 0
  const login = async () => {
    logins++
    throw new Error('Login must not run')
  }
  for (const includeLogin of [false, true]) {
    await expect(
      migrateNativeLocalForHost('opencode', {
        ...f.options,
        ...(includeLogin ? { login } : {}),
      }),
    ).rejects.toThrow(
      'OpenCode is still connected to the vault. Old local settings do not disconnect it. In OpenCode, run /claude → Accounts → Disconnect from the vault. Then run local setup again.',
    )
    expect(await bytes()).toEqual(before)
  }
  expect(logins).toBe(0)
  expect(f.calls).toEqual([])
})

for (const anthropic of [
  {
    type: 'oauth',
    access: 'synthetic-host-access',
    refresh: 'synthetic-host-refresh',
    expires: 1,
  },
  { type: 'api_key', key: 'synthetic-host-key' },
]) {
  test(`Pi vault setup deletes a consented stored ${anthropic.type} login and disconnect restores nothing`, async () => {
    const f = await fixture('pi')
    await writeHostAuth(f.paths.hostAuthPath, anthropic)
    const files = [
      ...new Set([
        f.paths.legacyConfigPath,
        f.paths.legacyStatePath,
        f.paths.paths.config,
        f.paths.paths.state,
        f.paths.paths.runtime,
        f.paths.paths.journal,
        f.paths.paths.roster,
        f.paths.routingDestinationPath,
      ]),
    ]
    for (const path of files) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, 'synthetic-invalid-local-recovery-data', {
        mode: 0o600,
      })
    }
    const bytes = () => Promise.all(files.map((path) => readFile(path)))
    const before = await bytes()
    expect(
      await activateNativeVaultForHost('pi', {
        ...f.options,
        removePiAnthropicAuth: true,
      }),
    ).toBe('committed')
    expect(await bytes()).toEqual(before)
    const paths = nativePiAuthSlotPaths({
      env: f.options.env,
      authPath: f.paths.hostAuthPath,
    })
    expect(paths.authPath).toBe(f.paths.hostAuthPath)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      anthropic: { type: 'api_key', key: paths.placeholderKey },
      other: OTHER_PROVIDER,
    })
    const slot = openNativePiAuthSlot({
      env: f.options.env,
      authPath: f.paths.hostAuthPath,
    })
    expect(await slot.inspect()).toEqual({
      slot: 'placeholder',
    })
    const activeHost = await readFile(paths.authPath)
    await expect(readFile(paths.stashPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await activateNativeVaultForHost('pi', f.options)).toBe(
      'already-vault',
    )
    expect(await readFile(paths.authPath)).toEqual(activeHost)
    await expect(readFile(paths.stashPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await bytes()).toEqual(before)
    expect(await readNativeEnrollmentMode('pi', f.options.env)).toBe(
      'claustrum',
    )
    expect(
      await disconnectNativeVaultForHost({
        host: 'pi',
        env: f.options.env,
        slot,
      }),
    ).toBe('disconnected')
    expect(JSON.parse(await readFile(f.paths.hostAuthPath, 'utf8'))).toEqual({
      other: OTHER_PROVIDER,
    })
    expect(await bytes()).toEqual(before)
    expect(await readNativeEnrollmentMode('pi', f.options.env)).toBe('local')
  })
}

test('Pi vault setup never opens a symlinked legacy stash', async () => {
  const f = await fixture('pi')
  await writeHostAuth(f.paths.hostAuthPath, {
    type: 'api_key',
    key: 'synthetic-original-login',
  })
  const { stashPath, placeholderKey } = nativePiAuthSlotPaths({
    env: f.options.env,
    authPath: f.paths.hostAuthPath,
  })
  await mkdir(dirname(stashPath), { recursive: true, mode: 0o700 })
  const target = join(f.root, 'legacy-secret')
  await writeFile(target, 'synthetic-unread-legacy-login', { mode: 0o600 })
  await symlink(target, stashPath)
  const opened: string[] = []
  const read = fsPromises.readFile
  const open = fsPromises.open
  const readSpy = spyOn(fsPromises, 'readFile').mockImplementation(((
    ...args: Parameters<typeof read>
  ) => {
    if (String(args[0]) === stashPath) {
      opened.push('readFile')
      throw new Error('Legacy stash must not be opened')
    }
    return read(...args)
  }) as typeof read)
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((...args) => {
    if (String(args[0]) === stashPath) {
      opened.push('open')
      throw new Error('Legacy stash must not be opened')
    }
    return open(...args)
  })
  try {
    await expect(
      activateNativeVaultForHost('pi', {
        ...f.options,
        removePiAnthropicAuth: true,
      }),
    ).rejects.toMatchObject({ name: 'PiSlotError', code: 'unsafe-path' })
    expect(opened).toEqual([])
  } finally {
    readSpy.mockRestore()
    openSpy.mockRestore()
  }
  expect(await readFile(target, 'utf8')).toBe('synthetic-unread-legacy-login')
  expect(
    JSON.parse(await readFile(f.paths.hostAuthPath, 'utf8')).anthropic,
  ).toEqual({
    type: 'api_key',
    key: placeholderKey,
  })
})
