import { expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { createAccountHomeCache, lookupAccountHome } from '../gateway.ts'
import { resetNativeHolderRegistryForTests } from '../holder-registry.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { canonicalPath, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { RELAY_PROXY_REFUSAL } from '../relay.ts'
import {
  createRelayLocationCheck,
  defaultRelayStoreFiles,
  RELAY_HOME_UNKNOWN_NOTE,
  RELAY_IGNORED_NOTE,
  RELAY_SAVE_HOME_UNKNOWN_REFUSAL,
  RELAY_SAVE_REFUSAL,
  TEST_RELAY_ACCOUNT_HOME_KEY,
} from '../relay-location.ts'
import { resetStateHomeServingGuardForTests } from '../state-home-serving-guard.ts'
import { decideOpenCodeStateLayout } from '../state-layout-decision.ts'
import { resetProcessStateLayoutsForTests } from '../state-layout-paths.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const hook = globalThis as Record<symbol, unknown>
const RELAY = {
  enabled: true,
  url: 'https://relay.example.test',
  token: 'synthetic-relay-token',
  transport: 'http' as const,
  fallbackToDirect: false,
}

async function scratch(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A migrated local OpenCode store in `dir`, with `relay` saved in it. */
async function storeWithRelay(dir: string, relay: object = RELAY) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const paths = await resolveNativePoolPaths(
    join(dir, 'anthropic-auth.json'),
    join(dir, 'anthropic-auth-state.json'),
  )
  await initializeNativeTestAuthority(paths)
  await createNativePoolStore({ paths, quota: nativeQuotaCodec }).initialize()
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          dir,
          'opencode-enrollment.json',
        ),
      },
    },
  })
  deferCleanup(() => runtime.close())
  // Saved while the check is skipped, as a store prepared by someone else.
  const previous = hook[TEST_RELAY_ACCOUNT_HOME_KEY]
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = 'unchecked'
  await runtime.updateRelay(relay)
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = previous
  return { paths, runtime }
}

test('a relay in the default store under the account home is used', async () => {
  const home = await scratch('relay-home-')
  const { runtime } = await storeWithRelay(join(home, '.config', 'opencode'))
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  expect(await runtime.getRelayConfig()).toMatchObject({
    url: RELAY.url,
    token: RELAY.token,
  })
  const snapshot = await runtime.read()
  expect(snapshot.policyStorage.relay?.enabled).toBe(true)
  expect(runtime.getRelayStatusNotes?.()).toEqual([])
  await runtime.assertRelayLocation()
  await runtime.updateRelay({ url: 'https://other-relay.example.test' })
  expect((await runtime.getRelayConfig())?.url).toBe(
    'https://other-relay.example.test',
  )
})

test('the default store reached through a symlinked folder still counts as the default', async () => {
  const home = await scratch('relay-home-')
  const elsewhere = await scratch('relay-real-')
  const { runtime } = await storeWithRelay(join(elsewhere, 'opencode'))
  await mkdir(join(home, '.config'), { recursive: true })
  await symlink(join(elsewhere, 'opencode'), join(home, '.config', 'opencode'))
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  expect((await runtime.getRelayConfig())?.url).toBe(RELAY.url)
})

test('a relay in a store outside the default place is ignored, shown as off, and cannot be saved', async () => {
  const home = await scratch('relay-home-')
  const elsewhere = await scratch('relay-moved-')
  const { runtime } = await storeWithRelay(join(elsewhere, 'opencode'))
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  expect(await runtime.getRelayConfig()).toBeNull()
  const snapshot = await runtime.read()
  expect(snapshot.policyStorage.relay?.enabled).toBe(false)
  expect(runtime.getRelayStatusNotes?.()).toEqual([RELAY_IGNORED_NOTE])
  for (const patch of [
    { enabled: true },
    { url: 'https://attacker.example.test' },
    { token: 'another-token' },
  ])
    await expect(runtime.updateRelay(patch)).rejects.toMatchObject({
      code: 'relay-not-default-location',
      message: RELAY_SAVE_REFUSAL,
    })
  await expect(runtime.assertRelayLocation()).rejects.toMatchObject({
    message: RELAY_SAVE_REFUSAL,
  })
  // Turning the relay off is still allowed.
  await runtime.updateRelay({ enabled: false })
  await runtime.read()
  expect(runtime.getRelayStatusNotes?.()).toEqual([])
})

test('a failed account lookup ignores the relay, says so, and refuses to save one', async () => {
  const home = await scratch('relay-home-')
  const { runtime } = await storeWithRelay(join(home, '.config', 'opencode'))
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => undefined
  expect(await runtime.getRelayConfig()).toBeNull()
  expect((await runtime.read()).policyStorage.relay?.enabled).toBe(false)
  expect(runtime.getRelayStatusNotes?.()).toEqual([RELAY_HOME_UNKNOWN_NOTE])
  await expect(
    runtime.updateRelay({ url: 'https://other-relay.example.test' }),
  ).rejects.toMatchObject({
    code: 'relay-account-home-unknown',
    message: RELAY_SAVE_HOME_UNKNOWN_REFUSAL,
  })
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = async () => {
    throw new Error('lookup failed')
  }
  expect(await runtime.getRelayConfig()).toBeNull()
  await expect(runtime.assertRelayLocation()).rejects.toMatchObject({
    message: RELAY_SAVE_HOME_UNKNOWN_REFUSAL,
  })
})

test('with no test hook set, the check runs: a temporary store never supplies a relay', async () => {
  const elsewhere = await scratch('relay-moved-')
  const { runtime } = await storeWithRelay(join(elsewhere, 'opencode'))
  delete hook[TEST_RELAY_ACCOUNT_HOME_KEY]
  expect(await runtime.getRelayConfig()).toBeNull()
})

/** The default store's vault relay files under `home`, created as regular files. */
async function defaultVaultFiles(home: string) {
  const dir = join(home, '.config', 'opencode')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const { local, vault } = await defaultRelayStoreFiles('opencode', home)
  for (const file of [vault.config, vault.runtime])
    await writeFile(file, '{}', { mode: 0o600 })
  return { local, vault }
}

test('a vault relay file that is a symbolic link is not the default store, even when it points there', async () => {
  const home = await realpath(await scratch('relay-home-'))
  const elsewhere = await realpath(await scratch('relay-moved-'))
  const defaults = await defaultVaultFiles(home)
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  // A folder chosen with the environment whose vault files link to the
  // default store's: the links could be repointed after any check.
  const selected = {
    config: join(elsewhere, 'anthropic-auth-vault-settings.json'),
    runtime: join(elsewhere, 'anthropic-auth-vault-state.json'),
  }
  await symlink(defaults.vault.config, selected.config)
  await symlink(defaults.vault.runtime, selected.runtime)
  const check = createRelayLocationCheck('opencode', {
    local: defaults.local,
    vault: selected,
  })
  expect(await check.locate('claustrum')).toBe('elsewhere')
  // Replaced later by regular files naming another relay: still elsewhere.
  for (const file of [selected.config, selected.runtime]) {
    await rm(file)
    await writeFile(file, '{}', { mode: 0o600 })
  }
  expect(await check.locate('claustrum')).toBe('elsewhere')
})

test('the selected store is checked again on every read, never from a cached answer', async () => {
  const home = await realpath(await scratch('relay-home-'))
  const elsewhere = await realpath(await scratch('relay-moved-'))
  const defaults = await defaultVaultFiles(home)
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  const check = createRelayLocationCheck('opencode', defaults)
  expect(await check.locate('claustrum')).toBe('default')
  // The default settings file becomes a link to a file elsewhere.
  const planted = join(elsewhere, 'anthropic-auth-vault-settings.json')
  await writeFile(planted, '{}', { mode: 0o600 })
  await rm(defaults.vault.config)
  await symlink(planted, defaults.vault.config)
  expect(await check.locate('claustrum')).toBe('elsewhere')
  await rm(defaults.vault.config)
  await writeFile(defaults.vault.config, '{}', { mode: 0o600 })
  expect(await check.locate('claustrum')).toBe('default')
})

test('a store found at the default place is read through the default files the check matched', async () => {
  const home = await realpath(await scratch('relay-home-'))
  const elsewhere = await realpath(await scratch('relay-moved-'))
  const defaults = await defaultVaultFiles(home)
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  // Selected through a folder link that reaches the default store: the files
  // to read are the default store's own, not this path text, which a swapped
  // folder could later point somewhere else.
  const link = join(elsewhere, 'link')
  await symlink(join(home, '.config', 'opencode'), link)
  const selected = {
    config: join(link, basename(defaults.vault.config)),
    runtime: join(link, basename(defaults.vault.runtime)),
  }
  const check = createRelayLocationCheck('opencode', {
    local: defaults.local,
    vault: selected,
  })
  expect(await check.resolve('claustrum')).toEqual({
    location: 'default',
    files: {
      config: await realpath(defaults.vault.config),
      runtime: await realpath(defaults.vault.runtime),
    },
  })
  await rm(link)
  await mkdir(link)
  expect(await check.resolve('claustrum')).toEqual({ location: 'elsewhere' })
})

test('a default store moved to the state folder keeps its relay, even after another store was checked first in the process', async () => {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
  deferCleanup(() => {
    resetProcessStateLayoutsForTests()
    resetNativeHolderRegistryForTests()
    resetStateHomeServingGuardForTests()
  })
  const root = await realpath(await scratch('relay-moved-layout-'))
  const home = join(root, 'home')
  const configDir = join(home, '.config', 'opencode')
  const defaultStore = await storeWithRelay(configDir)
  await defaultStore.runtime.close()
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  // Another runtime in the same process, on a store named by the
  // environment, checks its relay before the default store's layout is
  // decided.
  const other = await storeWithRelay(join(root, 'elsewhere', 'opencode'))
  expect(await other.runtime.getRelayConfig()).toBeNull()
  // The default store's start then moves its files to the state folder.
  const decision = await decideOpenCodeStateLayout({
    role: 'opencode2',
    env: { XDG_STATE_HOME: join(root, 'state') },
    home,
    timeouts: { layoutMs: 3_000, holderMs: 3_000, dataMs: 3_000 },
  })
  expect(decision.kind).toBe('state-home')
  const paths = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
  )
  expect(paths.runtime.startsWith(join(root, 'state'))).toBe(true)
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          configDir,
          'opencode-enrollment.json',
        ),
      },
    },
  })
  deferCleanup(() => runtime.close())
  expect(await runtime.getRelayConfig()).toMatchObject({
    url: RELAY.url,
    token: RELAY.token,
  })
})

test('a plain-http relay that a proxy setting would carry gets the refusal note', async () => {
  const home = await scratch('relay-home-')
  const { runtime } = await storeWithRelay(join(home, '.config', 'opencode'), {
    ...RELAY,
    url: 'http://127.0.0.1:9/relay',
  })
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  const saved = ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'].map(
    (key) => [key, process.env[key]] as const,
  )
  deferCleanup(() => {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
  })
  for (const [key] of saved) delete process.env[key]
  await runtime.read()
  expect(runtime.getRelayStatusNotes?.()).toEqual([])
  process.env.HTTP_PROXY = 'http://proxy.example.test:8080'
  expect(runtime.getRelayStatusNotes?.()).toEqual([RELAY_PROXY_REFUSAL])
  process.env.NO_PROXY = '127.0.0.1'
  expect(runtime.getRelayStatusNotes?.()).toEqual([])
})

test('the default stores are under .config/opencode and .pi/agent of the account home', async () => {
  const home = await scratch('relay-home-')
  const base = await canonicalPath(home)
  const opencode = await defaultRelayStoreFiles('opencode', home)
  expect(opencode.local.config).toBe(
    join(base, '.config', 'opencode', 'anthropic-auth-pool.json'),
  )
  expect(opencode.vault.config).toBe(
    join(base, '.config', 'opencode', 'anthropic-auth-vault-settings.json'),
  )
  const pi = await defaultRelayStoreFiles('pi', home)
  expect(pi.local.config).toBe(
    join(base, '.pi', 'agent', 'anthropic-auth-pool.json'),
  )
  expect(pi.local.runtime).toBe(
    join(base, '.pi', 'agent', 'anthropic-auth-native-state.json'),
  )
})

/**
 * A stubbed program runner: `outputs` is keyed by the program's path, or by
 * the program's path and its arguments joined with spaces.
 */
function lookup(
  platform: NodeJS.Platform,
  outputs: Record<string, string | Error>,
) {
  const calls: { file: string; args: readonly string[] }[] = []
  return {
    calls,
    dependencies: {
      platform,
      uid: 1000,
      run: async (file: string, args: readonly string[]) => {
        calls.push({ file, args })
        const output = outputs[[file, ...args].join(' ')] ?? outputs[file]
        if (output === undefined || output instanceof Error)
          throw output ?? new Error('not found')
        return output
      },
      readFile: async () => '',
    },
  }
}

const REG = 'C:\\Windows\\System32\\reg.exe'
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe'
const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001'
const WHOAMI_USER = `${WHOAMI} /user /fo csv /nh`
const PROFILE_LIST = `${REG} query HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${SID} /v ProfileImagePath`
const VOLATILE = `${REG} query HKCU\\Volatile Environment /v USERPROFILE`

test('the account home comes from the account database or the Windows registry', async () => {
  expect(
    await lookupAccountHome(
      lookup('linux', {
        '/usr/bin/getent': 'me:x:1000:1000:Me:/home/me:/bin/sh\n',
      }).dependencies,
    ),
  ).toBe('/home/me')
  expect(
    await lookupAccountHome(
      lookup('darwin', {
        '/usr/bin/id': 'me\n',
        '/usr/bin/dscl': 'NFSHomeDirectory: /Users/me\nUniqueID: 501\n',
      }).dependencies,
    ),
  ).toBeUndefined()
  // Windows: the profile folder recorded for the process account's SID,
  // which every kind of session has.
  const windows = lookup('win32', {
    [WHOAMI_USER]: `"desktop-1\\me","${SID}"\r\n`,
    [PROFILE_LIST]: `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\${SID}\r\n    ProfileImagePath    REG_EXPAND_SZ    C:\\Users\\me\r\n\r\n`,
  })
  expect(await lookupAccountHome(windows.dependencies)).toBe('C:\\Users\\me')
  expect(
    windows.calls.map((call) => [call.file, ...call.args].join(' ')),
  ).toEqual([WHOAMI_USER, PROFILE_LIST])
  // Without a usable profile-list entry, the signed-in user's volatile
  // environment key is used.
  const volatile =
    '\r\nHKEY_CURRENT_USER\\Volatile Environment\r\n    USERPROFILE    REG_SZ    C:\\Users\\me\r\n\r\n'
  const profileLists: Record<string, string>[] = [
    {},
    { [WHOAMI_USER]: `"desktop-1\\me","${SID}"\r\n` },
    {
      [WHOAMI_USER]: `"desktop-1\\me","${SID}"\r\n`,
      [PROFILE_LIST]:
        '    ProfileImagePath    REG_EXPAND_SZ    %SystemDrive%\\Users\\me\r\n',
    },
    // A SID that is not well formed never reaches a registry key name.
    { [WHOAMI_USER]: '"desktop-1\\me","S-1-5-21\\..\\x"\r\n' },
  ]
  for (const profileList of profileLists) {
    const fallback = lookup('win32', { ...profileList, [VOLATILE]: volatile })
    expect(await lookupAccountHome(fallback.dependencies)).toBe('C:\\Users\\me')
    expect(
      fallback.calls.some((call) => call.args.join(' ').includes('S-1-5-21\\')),
    ).toBe(false)
  }
  for (const output of [
    '    USERPROFILE    REG_SZ    %SystemDrive%\\Users\\me\r\n',
    '    USERPROFILE    REG_SZ    Users\\me\r\n',
    new Error('denied'),
  ])
    expect(
      await lookupAccountHome(
        lookup('win32', { [VOLATILE]: output }).dependencies,
      ),
    ).toBeUndefined()
})

test('a failed account-home lookup is retried in the background after a pause; a found home is kept', async () => {
  let now = 1_000
  const results: (string | undefined | Error)[] = [
    undefined,
    new Error('timed out'),
    '/home/me',
  ]
  let lookups = 0
  const home = createAccountHomeCache(
    async () => {
      const result = results[lookups++]
      if (result instanceof Error) throw result
      return result
    },
    { now: () => now, retryMs: 60_000 },
  )
  // The first lookup is awaited and fails.
  expect(await home()).toBeUndefined()
  expect(lookups).toBe(1)
  // Within the pause, no new lookup.
  now += 59_999
  expect(await home()).toBeUndefined()
  expect(lookups).toBe(1)
  // After it, a retry starts but the caller does not wait for it.
  now += 1
  expect(await home()).toBeUndefined()
  expect(lookups).toBe(2)
  await Bun.sleep(0)
  // That retry failed too, so the pause starts again.
  expect(await home()).toBeUndefined()
  expect(lookups).toBe(2)
  now += 60_000
  expect(await home()).toBeUndefined()
  expect(lookups).toBe(3)
  await Bun.sleep(0)
  // Found: kept for good, with no further lookups.
  expect(await home()).toBe('/home/me')
  now += 1_000_000
  expect(await home()).toBe('/home/me')
  expect(lookups).toBe(3)
})

test('no shipped source sets the relay test hook', async () => {
  const packages = resolve(import.meta.dir, '../../..')
  const offenders: string[] = []
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'node_modules') continue
        await walk(path)
      } else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
        const text = await readFile(path, 'utf8')
        if (text.includes('test-only.relay-account-home'))
          offenders.push(relative(packages, path))
      }
    }
  }
  for (const name of ['core', 'opencode', 'pi'])
    await walk(join(packages, name, 'src'))
  // Only the module that reads the hook names it.
  expect(offenders).toEqual(['core/src/relay-location.ts'])
})
