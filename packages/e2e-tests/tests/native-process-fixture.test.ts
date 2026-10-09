/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createNativeAccountRuntime,
  isCustodyTombstoneOAuth,
  readNativeMigrationJournal,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import { startFakeClaustrumDaemon } from '../src/mock-claustrum.ts'
import {
  FIXTURE_ADMITTED_ACCESS_TOKEN,
  type IsolatedEnv,
  OPENCODE_CONFIG_DEPS_ENV,
  removeE2ETempDir,
  type SpawnOptions,
  spawnOpencode,
} from '../src/opencode-runner.ts'

// These checks run the harness's real preparation path, offline migration
// included, up to the host spawn. A stand-in `opencode` executable records the
// environment it was started with and exits, so no OpenCode host runs here and
// these tests say nothing about how a real host serves.
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function scratchDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

/**
 * Run spawnOpencode with a stand-in host and keep its temp directory for
 * inspection. Returns the error spawnOpencode rejected with, the isolated
 * directories, and the stand-in's recorded environment (undefined when it
 * was never started).
 */
async function prepareWithoutHost(
  options: Omit<SpawnOptions, 'anthropicBaseURL'>,
  parentEnv: Record<string, string> = {},
) {
  const bin = await scratchDir('anthropic-auth-e2e-fake-host-')
  const recorder = join(bin, 'opencode')
  await writeFile(
    recorder,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync("child-env.json", JSON.stringify(process.env)); process.exit(7)'\n`,
  )
  await chmod(recorder, 0o700)
  let env: IsolatedEnv | undefined
  const savedPath = process.env.PATH
  const savedKeep = process.env.ANTHROPIC_AUTH_E2E_KEEP_TMP
  process.env.PATH = `${bin}:${savedPath ?? ''}`
  process.env.ANTHROPIC_AUTH_E2E_KEEP_TMP = '1'
  const savedParent = Object.fromEntries(Object.keys(parentEnv).map((key) => [key, process.env[key]]))
  Object.assign(process.env, parentEnv)
  let failure: unknown
  try {
    await spawnOpencode({
      ...options,
      anthropicBaseURL: 'http://127.0.0.1:9',
      beforeSpawn: async (isolated) => {
        env = isolated
        cleanups.push(() => removeE2ETempDir(isolated.tempDir))
        await options.beforeSpawn?.(isolated)
      },
    })
  } catch (error) {
    failure = error
  } finally {
    process.env.PATH = savedPath
    for (const [key, value] of Object.entries(savedParent)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (savedKeep === undefined) delete process.env.ANTHROPIC_AUTH_E2E_KEEP_TMP
    else process.env.ANTHROPIC_AUTH_E2E_KEEP_TMP = savedKeep
  }
  if (!env) throw new Error('spawnOpencode did not reach beforeSpawn')
  const recorded = await readFile(join(env.workdir, 'child-env.json'), 'utf8').then(
    (text) => JSON.parse(text) as Record<string, string>,
    () => undefined,
  )
  const paths = await resolveNativePoolPaths(
    join(env.configDir, 'anthropic-auth.json'),
    join(env.configDir, 'anthropic-auth-state.json'),
  )
  const hostAuthPath = join(env.dataDir, 'opencode', 'auth.json')
  return { failure, env, recorded, paths, hostAuthPath }
}

/** A local credential source that fails if the runtime tries to exchange a token or look up an account. */
function offlineOnly() {
  const calls: string[] = []
  return {
    calls,
    local: {
      refreshToken: async () => {
        calls.push('refreshToken')
        throw new Error('host would need the network to exchange a token')
      },
      resolveIdentity: async () => {
        calls.push('resolveIdentity')
        throw new Error('host would need the network to look up the account')
      },
    },
  }
}

describe('native process fixture preparation', () => {
  it('migrates a local login before the host starts and leaves it servable without network', async () => {
    const run = await prepareWithoutHost({
      relay: { url: 'http://127.0.0.1:9', token: 'relay-token', transport: 'websocket' },
      quotaFeed: true,
      hybridCache: true,
    })
    expect(String(run.failure)).toContain('opencode exited before announcing its listener (code=7')
    const child = run.recorded!
    expect(child).toBeDefined()
    expect(child.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(child.HOME).toBe(run.env.homeDir)
    expect(child.USERPROFILE).toBe(run.env.homeDir)
    expect(child.XDG_CONFIG_HOME).toBe(run.env.configDir)
    expect(child.XDG_DATA_HOME).toBe(run.env.dataDir)
    expect(child.OPENCODE_ANTHROPIC_AUTH_FILE).toBe(join(run.env.configDir, 'anthropic-auth.json'))
    expect(child.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE).toBe(
      join(await realpath(run.env.configDir), 'anthropic-auth-pool-routing-state.json'),
    )

    expect(await readNativeMigrationJournal(run.paths)).toMatchObject({ phase: 'retired' })
    // Retirement removed the legacy config. OpenCode's auth.json keeps only a
    // non-secret marker that activates the plugin; the real access and
    // refresh tokens moved to the shared credential store.
    expect(await exists(run.paths.legacyConfig)).toBe(false)
    const hostAuth = await readFile(run.hostAuthPath, 'utf8')
    expect(isCustodyTombstoneOAuth(JSON.parse(hostAuth).anthropic, 'anthropic')).toBe(true)
    expect(hostAuth).not.toContain('test-access-token')

    // A runtime that cannot reach any provider stands in for the host: the
    // main account must be usable from the validation recorded before spawn.
    const offline = offlineOnly()
    const runtime = createNativeAccountRuntime({ paths: run.paths, host: 'opencode', local: offline.local })
    try {
      const snapshot = await runtime.read()
      expect(snapshot.mode).toBe('local')
      expect(snapshot.accounts.map(({ id, type, source }) => ({ id, type, source }))).toEqual([
        { id: 'main', type: 'oauth', source: 'local' },
      ])
      const admitted = await runtime.authorizeLocal('main', { intent: 'serve' })
      expect(admitted).toMatchObject({ status: 'usable', access: FIXTURE_ADMITTED_ACCESS_TOKEN })
      expect(offline.calls).toEqual([])
      expect(await runtime.getRelayConfig()).toMatchObject({
        url: 'http://127.0.0.1:9',
        token: 'relay-token',
        transport: 'websocket',
      })
    } finally {
      runtime.close()
    }
  })

  it('keeps an OpenCode API-key activation under host control', async () => {
    const run = await prepareWithoutHost({
      nativeAccounts: { kind: 'local', hostAuth: { anthropic: { type: 'api', key: 'synthetic-api-key' } } },
    })
    expect(run.recorded?.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(await readNativeMigrationJournal(run.paths)).toMatchObject({ phase: 'retired' })
    expect(JSON.parse(await readFile(run.hostAuthPath, 'utf8')).anthropic).toEqual({
      type: 'api',
      key: 'synthetic-api-key',
    })
    const runtime = createNativeAccountRuntime({ paths: run.paths, host: 'opencode' })
    try {
      expect((await runtime.read()).accounts).toEqual([])
    } finally {
      runtime.close()
    }
  })

  it('refuses to migrate, and never starts the host, while OPENCODE_AUTH_CONTENT is set', async () => {
    const run = await prepareWithoutHost({
      childEnv: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: 'api', key: 'synthetic-api-key' } }),
      },
    })
    expect(String(run.failure)).toContain('OPENCODE_AUTH_CONTENT')
    expect(run.recorded).toBeUndefined()
    expect(await readNativeMigrationJournal(run.paths)).toBeUndefined()
    expect(await exists(run.paths.config)).toBe(false)
    expect(await exists(run.paths.legacyConfig)).toBe(true)
  })

  it('leaves a deliberately unmigrated fixture on its legacy files', async () => {
    const run = await prepareWithoutHost({ nativeAccounts: { kind: 'unmigrated' } })
    expect(String(run.failure)).toContain('opencode exited before announcing its listener (code=7')
    expect(JSON.parse(run.recorded!.OPENCODE_AUTH_CONTENT!).anthropic).toMatchObject({
      type: 'oauth',
      access: 'test-access-token',
    })
    expect(await readNativeMigrationJournal(run.paths)).toBeUndefined()
    expect(await exists(run.paths.legacyConfig)).toBe(true)
    expect(await exists(run.hostAuthPath)).toBe(false)
  })

  it('gives a deliberately unmigrated fixture a real auth.json instead of OPENCODE_AUTH_CONTENT', async () => {
    const run = await prepareWithoutHost({
      nativeAccounts: { kind: 'unmigrated', hostAuth: { anthropic: { type: 'oauth', access: '', refresh: 'claustrum-tombstone:v1:anthropic', expires: 0 } } },
    })
    expect(String(run.failure)).toContain('opencode exited before announcing its listener (code=7')
    expect(run.recorded?.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(isCustodyTombstoneOAuth(JSON.parse(await readFile(run.hostAuthPath, 'utf8')).anthropic, 'anthropic')).toBe(true)
    expect(await readNativeMigrationJournal(run.paths)).toBeUndefined()
    expect(await exists(run.paths.legacyConfig)).toBe(true)
  })

  it('discovers vault accounts through the mock daemon named in the child environment', async () => {
    const daemonDir = await scratchDir('anthropic-auth-e2e-fixture-vault-')
    const daemon = await startFakeClaustrumDaemon({
      directory: daemonDir,
      scopedCredentials: {
        'oauth:anthropic': {
          payload: 'scoped-main',
          account_id: 'account-main',
          record_version: 1,
          expires_at_ms: Date.now() + 3_600_000,
        },
      },
    })
    cleanups.push(() => daemon.stop())
    const run = await prepareWithoutHost({
      nativeAccounts: { kind: 'vault' },
      childEnv: { OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: daemon.connectionFile },
      beforeSpawn: async (env) => {
        await writeFile(join(env.configDir, 'anthropic-auth.json'), JSON.stringify({
          version: 1, accounts: [], quota: { enabled: false },
          claustrum: { mode: 'claustrum', scopedRoster: true, primaryAccount: { credentialId: 'oauth:anthropic', accountId: 'account-main', state: 'active' } },
        }), { mode: 0o600 })
        await writeFile(join(env.configDir, 'claustrum-enrollment.json'), JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }), { mode: 0o600 })
      },
    })
    expect(String(run.failure)).toContain('opencode exited before announcing its listener (code=7')
    expect(run.recorded?.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(await readNativeMigrationJournal(run.paths)).toMatchObject({ phase: 'retired' })
    expect(daemon.scopedLists).toBeGreaterThan(0)
    expect(daemon.credentialGets).toEqual([])
    expect(isCustodyTombstoneOAuth(JSON.parse(await readFile(run.hostAuthPath, 'utf8')).anthropic, 'anthropic')).toBe(true)
    const roster = await readFile(run.paths.roster, 'utf8')
    expect(roster).toContain('oauth:anthropic')
    expect(roster).not.toContain('scoped-main')
    const runtime = createNativeAccountRuntime({ paths: run.paths, host: 'opencode' })
    try {
      const snapshot = await runtime.read()
      expect(snapshot.mode).toBe('claustrum')
      expect(snapshot.accounts.find((account) => account.id === 'main')).toMatchObject({
        source: 'vault',
        credentialId: 'oauth:anthropic',
      })
    } finally {
      runtime.close()
    }
  })

  it('refuses a vault fixture whose daemon connection is not named explicitly', async () => {
    const run = await prepareWithoutHost({ nativeAccounts: { kind: 'vault' } })
    expect(String(run.failure)).toContain('OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE')
    expect(run.recorded).toBeUndefined()
    expect(await readNativeMigrationJournal(run.paths)).toBeUndefined()
  })
})

const configDepsFixture = resolve(import.meta.dir, '../fixtures/opencode1-config-deps')
// The committed fixture holds only package.json and package-lock.json; a
// runner provisions node_modules from that lockfile. Without it, the copy
// cannot be checked here, and the test reports itself as skipped.
const configDepsInstalled = await lstat(join(configDepsFixture, 'node_modules', '.package-lock.json')).then(
  () => true,
  () => false,
)

/** The check OpenCode 1.18.18 makes before skipping its own install (npm.ts Npm.install). */
async function opencodeWouldSkipInstall(dir: string) {
  if (!(await exists(join(dir, 'node_modules')))) return false
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8'))
  const names = (value: Record<string, unknown> | undefined) =>
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
      Object.keys((value?.[field] as Record<string, string> | undefined) ?? {}),
    )
  const locked = new Set(names(lock.packages?.['']))
  return [...names(manifest), '@opencode-ai/plugin'].every((name) => locked.has(name))
}

describe('OpenCode config-directory dependency fixture', () => {
  it.skipIf(!configDepsInstalled)('copies the installed plugin dependency tree into every OpenCode config directory', async () => {
    const run = await prepareWithoutHost({}, { [OPENCODE_CONFIG_DEPS_ENV]: configDepsFixture })
    expect(String(run.failure)).toContain('opencode exited before announcing its listener (code=7')
    const fixtureLock = JSON.parse(await readFile(join(configDepsFixture, 'package-lock.json'), 'utf8'))
    for (const dir of [run.env.configDir, join(run.env.configDir, 'opencode')]) {
      expect(await opencodeWouldSkipInstall(dir)).toBe(true)
      expect(JSON.parse(await readFile(join(dir, 'package-lock.json'), 'utf8'))).toEqual(fixtureLock)
      const plugin = JSON.parse(await readFile(join(dir, 'node_modules', '@opencode-ai', 'plugin', 'package.json'), 'utf8'))
      expect(plugin.version).toBe('1.18.18')
      expect((await lstat(join(dir, 'node_modules', '@opencode-ai', 'plugin', plugin.exports['.'].import))).size).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(join(dir, 'node_modules', '@opencode-ai', 'sdk', 'package.json'), 'utf8')).version).toBe('1.18.18')
    }
  })

  it('refuses an uninstalled dependency fixture before the host starts', async () => {
    const incomplete = await scratchDir('anthropic-auth-e2e-config-deps-')
    for (const name of ['package.json', 'package-lock.json'])
      await cp(join(configDepsFixture, name), join(incomplete, name))
    await mkdir(join(incomplete, 'node_modules'))
    const run = await prepareWithoutHost({}, { [OPENCODE_CONFIG_DEPS_ENV]: incomplete })
    expect(String(run.failure)).toContain('has no npm-installed node_modules')
    expect(run.recorded).toBeUndefined()
    for (const dir of [run.env.configDir, join(run.env.configDir, 'opencode')])
      expect(await exists(join(dir, 'node_modules'))).toBe(false)
  })
})
