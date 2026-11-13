import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import {
  createNativePoolStore,
  decideOpenCodeStateLayout,
  decideOpenCodeStateLayoutOnce,
  getSettingsFilePath,
  HOLDER_FILE_NAME,
  HOLDER_REGISTRATION_ERROR_MESSAGES,
  isDumpEnabled,
  LEGACY_STATE_LAYOUT,
  publishNativeEmptyInit,
  resetNativeHolderRegistryForTests,
  resetProcessStateLayoutsForTests,
  resetStateLayoutDecisionsForTests,
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
  resolveStateHomeTarget,
  setDumpEnabled,
  setRelocationMoveEnabledForTests,
  stateLayoutRefusalPublicMessage,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { parse } from 'jsonc-parser'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { relaySetup } from '../cli'
import { AnthropicAuthPlugin } from '../index'
import { runSetupCommand } from '../setup/command'
import { setupAnthropicAuth, startFailure } from '../v2/setup'

/**
 * Environment variables a host start reads to find OpenCode's config folder
 * and state folder, or that name anthropic-auth files. Each test sets its
 * own and puts these back afterwards.
 */
const ENV_KEYS = [
  'ANTHROPIC_AUTH_SETTINGS_FILE',
  'OPENCODE_CONFIG_DIR',
  'XDG_STATE_HOME',
  'TMPDIR',
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_TUI_PREFERENCES_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_AUTH_CONTENT',
] as const

const cleanups: Array<() => unknown> = []

function resetDecisions() {
  resetStateLayoutDecisionsForTests()
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
}

beforeEach(resetDecisions)

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setRelocationMoveEnabledForTests(undefined)
  resetDecisions()
})

/**
 * An empty OpenCode config folder and a state folder beside it, named by the
 * process environment the hosts read, with the move turned on or off.
 */
async function machine(moveEnabled: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'layout-wiring-')))
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  cleanups.push(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  for (const key of ENV_KEYS) delete process.env[key]
  const configDir = join(root, 'config')
  const stateRoot = join(root, 'state')
  await mkdir(configDir)
  // Older versions' pid artifacts are looked for under the temporary folder;
  // keep this test's own.
  await mkdir(join(root, 'tmp'))
  process.env.OPENCODE_CONFIG_DIR = configDir
  process.env.XDG_STATE_HOME = stateRoot
  process.env.TMPDIR = join(root, 'tmp')
  setRelocationMoveEnabledForTests(moveEnabled)
  return { root, configDir, stateRoot }
}

async function defaultMachine(moveEnabled: boolean) {
  const m = await machine(moveEnabled)
  const saved = new Map(
    ['HOME', 'XDG_CONFIG_HOME'].map((key) => [key, process.env[key]]),
  )
  cleanups.push(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.HOME = m.root
  process.env.XDG_CONFIG_HOME = join(m.root, '.config')
  delete process.env.OPENCODE_CONFIG_DIR
  const configDir = join(m.root, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  return { ...m, configDir }
}

type Machine = Awaited<ReturnType<typeof machine>>

async function initializeAuthority() {
  const paths = await resolveNativePoolPaths(
    undefined,
    undefined,
    LEGACY_STATE_LAYOUT,
  )
  await publishNativeEmptyInit({
    paths,
    routingDestinationPath: resolveLocalRoutingDestination(
      'opencode',
      paths,
      process.env,
    ),
    env: { ...process.env },
    processFence: async () => {},
  })
}

/** The state-home subfolder this config folder has, if any. */
async function subfolder(m: Machine) {
  const parent = join(m.stateRoot, 'cortexkit', 'anthropic-auth')
  const names = (await readdir(parent).catch(() => [] as string[])).filter(
    (name) => /^opencode(-[0-9a-f]{16})?$/.test(name),
  )
  return names.length ? join(parent, names[0] as string) : undefined
}

async function holderEntries(dir: string) {
  const text = await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')
  return (JSON.parse(text) as { entries: Array<Record<string, unknown>> })
    .entries
}

/** What a start decided, as seen on disk. */
async function expectDecided(m: Machine, role: string, moved: boolean) {
  const sub = await subfolder(m)
  if (!moved) {
    // Nothing is created in the state folder, not even the subfolder.
    expect(sub).toBeUndefined()
    expect(await holderEntries(m.configDir)).toContainEqual(
      expect.objectContaining({ pid: process.pid, role, kind: 'legacy' }),
    )
    return
  }
  if (!sub) throw new Error('the dataset was not moved')
  const record = JSON.parse(await readFile(join(sub, 'layout.json'), 'utf8'))
  expect(record).toMatchObject({ phase: 'committed', cleanup: 'done' })
  expect(await holderEntries(sub)).toContainEqual(
    expect.objectContaining({ pid: process.pid, role, kind: 'state-home' }),
  )
}

/** OpenCode 2's plugin context with every registration accepted. */
function openCode2Context() {
  const registration = { dispose: async () => {} }
  return {
    session: {
      get: async () => ({ parentID: undefined }),
      hook: async () => registration,
    },
    model: { transform: async () => registration },
    provider: { transform: async () => registration },
    integration: { transform: async () => registration },
    rpc: {
      register: async () => ({
        ...registration,
        events: { emit: async () => {} },
      }),
    },
    command: { transform: async () => registration },
    event: { subscribe: async function* () {} },
  } as unknown as Plugin.Context
}

async function startHost(host: 'opencode1' | 'opencode2', m: Machine) {
  if (host === 'opencode2') {
    const dispose = await setupAnthropicAuth(openCode2Context(), {
      vault: { env: { ...process.env } },
    })
    cleanups.push(dispose)
    return
  }
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    m.root,
    'registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(m.root, 'feed')
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(m.root, 'rpc')
  const plugin = await AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'legacy-settings-fixture',
        worktree: m.root,
        time: { created: Date.now() },
      },
      directory: m.root,
      worktree: m.root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    {
      scopedRosterPollIntervalMs: 0,
      cacheKeepAggregateRefreshIntervalMs: 0,
    },
  )
  cleanups.push(() => plugin.dispose?.())
}

test('OpenCode 2 state-home admission permits the settings move without a per-plugin holder lease', async () => {
  const m = await machine(true)
  const dump = isDumpEnabled()
  cleanups.push(() => setDumpEnabled(dump))
  const target = join(m.root, 'settings.jsonc')
  process.env.ANTHROPIC_AUTH_SETTINGS_FILE = target
  await initializeAuthority()
  const paths = await resolveNativePoolPaths(
    undefined,
    undefined,
    LEGACY_STATE_LAYOUT,
  )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.updateSettings(() => ({ dump: { enabled: true } }))
  await store.close()
  const dispose = await setupAnthropicAuth(openCode2Context(), {
    vault: { env: { ...process.env } },
  })
  cleanups.push(dispose)
  await expectDecided(m, 'opencode2', true)
  expect(parse(await readFile(target, 'utf8')).dump_enabled).toBe(true)
  expect(JSON.parse(await readFile(`${target}.moved`, 'utf8')).target).toBe(
    target,
  )
})

for (const host of ['opencode1', 'opencode2'] as const) {
  for (const override of [
    'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
    'OPENCODE_TUI_PREFERENCES_FILE',
  ] as const)
    test(`${host} default-path legacy registration permits the settings move with ${override}`, async () => {
      const m = await defaultMachine(true)
      process.env[override] = join(m.root, 'override.json')
      const dump = isDumpEnabled()
      cleanups.push(() => setDumpEnabled(dump))
      await initializeAuthority()
      const paths = await resolveNativePoolPaths(
        undefined,
        undefined,
        LEGACY_STATE_LAYOUT,
      )
      const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
      await store.updateSettings(() => ({ dump: { enabled: true } }))
      await store.close()
      const target = getSettingsFilePath()
      await startHost(host, m)
      const decision = await decideOpenCodeStateLayoutOnce({ role: host })
      expect(decision.kind).toBe('legacy')
      expect(decision.layout).toEqual(LEGACY_STATE_LAYOUT)
      expect(await holderEntries(m.configDir)).toContainEqual(
        expect.objectContaining({
          pid: process.pid,
          role: host,
          kind: 'legacy',
        }),
      )
      const sub = await subfolder(m)
      if (sub)
        await expect(
          readFile(join(sub, 'layout.json'), 'utf8'),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        })
      expect(parse(await readFile(target, 'utf8')).dump_enabled).toBe(true)
      expect(JSON.parse(await readFile(`${target}.moved`, 'utf8')).target).toBe(
        target,
      )
    })

  test(`${host} pending legacy registration still prevents the settings move`, async () => {
    const m = await defaultMachine(false)
    process.env.OPENCODE_TUI_PREFERENCES_FILE = join(m.root, 'sidebar.json')
    const dump = isDumpEnabled()
    cleanups.push(() => setDumpEnabled(dump))
    await initializeAuthority()
    const paths = await resolveNativePoolPaths(
      undefined,
      undefined,
      LEGACY_STATE_LAYOUT,
    )
    const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
    await store.updateSettings(() => ({ dump: { enabled: true } }))
    await store.close()
    await writeFile(join(m.configDir, HOLDER_FILE_NAME), '{ invalid')
    const target = getSettingsFilePath()
    await startHost(host, m)
    const decision = await decideOpenCodeStateLayoutOnce({ role: host })
    expect(decision.kind).toBe('legacy')
    if (decision.kind !== 'legacy') throw new Error('not expected')
    expect(decision.registration?.status).toBe('pending')
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(readFile(`${target}.moved`, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
}

for (const moveEnabled of [false, true]) {
  const label = moveEnabled ? 'on' : 'off'

  test(`OpenCode 2 decides the layout at setup with moving ${label}`, async () => {
    const m = await machine(moveEnabled)
    const dispose = await setupAnthropicAuth(openCode2Context(), {
      vault: { env: { ...process.env } },
    })
    cleanups.push(() => dispose())
    await expectDecided(m, 'opencode2', moveEnabled)
  })

  test(`the CLI decides the layout before its first pool read with moving ${label}`, async () => {
    const m = await machine(moveEnabled)
    // A refused unmigrated command does no pool I/O and must not write a holder.
    // Seed a completed migration journal so this case reaches its pool-read check.
    await initializeAuthority()
    // The command stops at its first prompt, after it has opened the pool.
    await expect(
      relaySetup({
        prompt: async () => {
          throw new Error('stop here')
        },
      }),
    ).rejects.toThrow('stop here')
    await expectDecided(m, 'cli', moveEnabled)
  })

  test(`setup decides the layout before resolving OpenCode's paths with moving ${label}`, async () => {
    const m = await machine(moveEnabled)
    const chunks: string[] = []
    const output = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    })
    // Setup may stop later for this empty folder; the decision comes first.
    await runSetupCommand(['--yes', '--no-claustrum', '--opencode=1'], {
      env: { ...process.env, PATH: join(m.root, 'bin') },
      platform: 'linux',
      fence: { listRunningHosts: async () => [] },
      runner: {
        run: async () => ({ exitCode: 0, stdout: '1.18.30\n', stderr: '' }),
      },
      terminal: { input: process.stdin, output },
    })
    await expectDecided(m, 'setup', moveEnabled)
  })
}

test('the CLI authority preflight reads an already-moved dataset from state-home', async () => {
  const m = await machine(true)
  await initializeAuthority()
  const setupDecision = await decideOpenCodeStateLayout({ role: 'setup' })
  expect(setupDecision.kind).toBe('state-home')
  resetDecisions()
  await expect(
    relaySetup({
      prompt: async () => {
        throw new Error('moved pool reached')
      },
    }),
  ).rejects.toThrow('moved pool reached')
  await expectDecided(m, 'cli', true)
})

test('OpenCode 2 refuses at setup with the fixed text of a layout refusal, naming no folder', async () => {
  const m = await machine(false)
  // The config folder's runtime file is a tombstone pointing at the state
  // folder, and the record of the move there can't be read: no copy may be
  // served.
  const target = resolveStateHomeTarget()
  if (!target) throw new Error('the config folder has no identity')
  await mkdir(target.dir, { recursive: true })
  await Bun.write(
    join(m.configDir, 'anthropic-auth-native-state.json'),
    JSON.stringify({
      version: 0,
      relocatedTo: target.dir,
      stateRoot: target.stateRoot,
      identity: target.identity,
      attempt: '00000000-0000-4000-8000-000000000000',
      by: 'test',
    }),
  )
  await Bun.write(join(target.dir, 'layout.json'), '{ not json')
  const failure = await setupAnthropicAuth(openCode2Context(), {
    vault: { env: { ...process.env } },
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  const message = (failure as Error).message
  expect(message).toBe(stateLayoutRefusalPublicMessage('marker-unreadable'))
  expect(message).not.toContain(m.root)
})

test('OpenCode 2 with moving off serves its config folder when the state folder holds a corrupt record but the config folder shows no move', async () => {
  const m = await machine(false)
  const target = resolveStateHomeTarget()
  if (!target) throw new Error('the config folder has no identity')
  await mkdir(target.dir, { recursive: true })
  await Bun.write(join(target.dir, 'layout.json'), '{ not json')
  const dispose = await setupAnthropicAuth(openCode2Context(), {
    vault: { env: { ...process.env } },
  })
  cleanups.push(() => dispose())
  expect(await holderEntries(m.configDir)).toContainEqual(
    expect.objectContaining({
      pid: process.pid,
      role: 'opencode2',
      kind: 'legacy',
    }),
  )
})

/** A writable stream that keeps what is written to it. */
function captured() {
  const chunks: string[] = []
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    }),
  }
}

test('setup --restore-legacy refuses while a host runs, and otherwise dispatches to the restore and prints where the state went', async () => {
  const m = await machine(true)
  // Move a migrated empty dataset before testing restore.
  await initializeAuthority()
  await expect(
    relaySetup({
      prompt: async () => {
        throw new Error('stop here')
      },
    }),
  ).rejects.toThrow('stop here')
  const sub = await subfolder(m)
  if (!sub) throw new Error('the dataset was not moved')
  const running = captured()
  expect(
    await runSetupCommand(['--restore-legacy'], {
      env: { ...process.env },
      fence: {
        listRunningHosts: async () => [{ pid: 1234, command: 'opencode' }],
      },
      terminal: { input: process.stdin, output: running.stream },
    }),
  ).toBe(1)
  expect(
    JSON.parse(await readFile(join(sub, 'layout.json'), 'utf8')).phase,
  ).toBe('committed')
  const stopped = captured()
  const calls: unknown[] = []
  expect(
    await runSetupCommand(['--restore-legacy'], {
      env: { ...process.env },
      fence: { listRunningHosts: async () => [] },
      terminal: { input: process.stdin, output: stopped.stream },
      restoreLegacy: async (options) => {
        calls.push(options)
        return { status: 'restored', oldDir: m.configDir, sub, kept: [] }
      },
    }),
  ).toBe(0)
  expect(calls).toHaveLength(1)
  expect(stopped.chunks.join('')).toContain(m.configDir)
})

test('setup --restore-legacy puts a moved fixture tree back in the config folder, byte for byte', async () => {
  const m = await machine(true)
  // A dataset of the closed list: both runtimes and the vault files.
  const fixture: Record<string, string> = {
    'anthropic-auth-native-state.json': '{"version":1,"note":"local"}\n',
    'anthropic-auth-vault-state.json': '{"version":1,"note":"vault"}\n',
    'anthropic-auth-vault-store-state.json': '{"accounts":{},"version":1}\n',
    'anthropic-auth-vault-roster.json': '{"roster":"vault"}\n',
    'anthropic-auth-vault-routing-state.json': '{"routing":"vault"}\n',
  }
  for (const [name, text] of Object.entries(fixture))
    await writeFile(join(m.configDir, name), text, { mode: 0o600 })
  const decision = await decideOpenCodeStateLayout({ role: 'cli' })
  expect(decision.kind).toBe('state-home')
  const sub = await subfolder(m)
  if (!sub) throw new Error('the dataset was not moved')
  expect(
    await readFile(join(m.configDir, 'anthropic-auth-vault-roster.json'), {
      encoding: 'utf8',
    }).catch(() => undefined),
  ).toBeUndefined()
  // The host that moved it has exited: no process is registered.
  for (const dir of [m.configDir, sub])
    await writeFile(
      join(dir, HOLDER_FILE_NAME),
      JSON.stringify({ version: 1, entries: [] }),
    ).catch(() => {})
  const out = captured()
  expect(
    await runSetupCommand(['--restore-legacy'], {
      env: { ...process.env },
      fence: { listRunningHosts: async () => [] },
      terminal: { input: process.stdin, output: out.stream },
    }),
  ).toBe(0)
  expect(out.chunks.join('')).toContain(m.configDir)
  for (const [name, text] of Object.entries(fixture))
    expect(await readFile(join(m.configDir, name), 'utf8')).toBe(text)
  expect(
    JSON.parse(await readFile(join(sub, 'layout.json'), 'utf8')),
  ).toMatchObject({ phase: 'restored', restore: { cleanup: 'done' } })
  // The state folder keeps no data file of the closed list.
  const left = await readdir(sub)
  for (const name of Object.keys(fixture)) expect(left).not.toContain(name)
})

for (const variant of [
  'state-home layout',
  'destination-shaped folder',
  'managed folder',
] as const)
  test(`OpenCode 2 refuses injected paths that reach into the state folder (${variant}), with the fixed text and no registration there`, async () => {
    const m = await machine(false)
    // Each fixture trips exactly one of the checks of injected paths.
    // State-home layout: the runtime files sit apart from the account files,
    // in a folder that is neither destination-shaped nor managed.
    const plain = join(m.root, 'plain-state')
    await mkdir(plain)
    // Destination-shaped: legacy-layout files in a folder named like a
    // state-home subfolder, with no marker in it.
    const shaped = join(
      m.root,
      'elsewhere',
      'cortexkit',
      'anthropic-auth',
      'opencode-0123456789abcdef',
    )
    await mkdir(shaped, { recursive: true })
    // Managed: legacy-layout files in an ordinarily named folder holding the
    // marker of a moved dataset.
    const managed = join(m.root, 'managed')
    await mkdir(managed)
    await Bun.write(join(managed, 'config-dir.json'), '{}\n')
    const paths =
      variant === 'state-home layout'
        ? await resolveNativePoolPaths(
            join(m.configDir, 'anthropic-auth.json'),
            join(m.configDir, 'anthropic-auth-state.json'),
            { kind: 'state-home', dir: plain },
          )
        : await resolveNativePoolPaths(
            join(
              variant === 'managed folder' ? managed : shaped,
              'anthropic-auth.json',
            ),
            join(
              variant === 'managed folder' ? managed : shaped,
              'anthropic-auth-state.json',
            ),
            LEGACY_STATE_LAYOUT,
          )
    const failure = await setupAnthropicAuth(openCode2Context(), {
      paths,
      vault: { env: { ...process.env } },
    }).then(
      (dispose) => {
        cleanups.push(() => dispose())
        return undefined
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(HOLDER_REGISTRATION_ERROR_MESSAGES).toContain(message)
    expect(message).not.toContain(m.root)
    for (const dir of [m.configDir, plain, shaped, managed])
      expect(await Bun.file(join(dir, HOLDER_FILE_NAME)).exists()).toBe(false)
  })

test('OpenCode 2 hands any error its start does not recognise on as fixed text, naming no path', async () => {
  const root = join(tmpdir(), 'private-folder-name')
  const raw = Object.assign(
    new Error(`EACCES: permission denied, open '${root}/layout.json.lock'`),
    { code: 'EACCES' },
  )
  const shown = startFailure(raw)
  expect(shown.message).toBe(stateLayoutRefusalPublicMessage('io-failed'))
  expect(shown.message).not.toContain(root)
})

test('OpenCode 2 with moving off refuses with fixed text when the config folder shows a move and the layout lock fails with an I/O error', async () => {
  const m = await machine(true)
  await Bun.write(
    join(m.configDir, 'anthropic-auth-native-state.json'),
    '{"version":1}\n',
  )
  expect((await decideOpenCodeStateLayout({ role: 'cli' })).kind).toBe(
    'state-home',
  )
  const sub = await subfolder(m)
  if (!sub) throw new Error('the dataset was not moved')
  // A cleanup still pending keeps the start off the fast admission, so it
  // takes the layout lock.
  const record = JSON.parse(await readFile(join(sub, 'layout.json'), 'utf8'))
  await writeFile(
    join(sub, 'layout.json'),
    JSON.stringify({ ...record, cleanup: 'pending' }),
  )
  setRelocationMoveEnabledForTests(false)
  resetDecisions()
  // The state folder can't take new files: the layout lock file can't be
  // created (EACCES).
  await chmod(sub, 0o500)
  cleanups.push(() => chmod(sub, 0o700))
  const failure = await setupAnthropicAuth(openCode2Context(), {
    vault: { env: { ...process.env } },
  }).then(
    (dispose) => {
      cleanups.push(() => dispose())
      return undefined
    },
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  const message = (failure as Error).message
  expect(message).toBe(stateLayoutRefusalPublicMessage('io-failed'))
  expect(message).not.toContain(m.root)
})
