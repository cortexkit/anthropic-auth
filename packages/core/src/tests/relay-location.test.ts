import { expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { lookupAccountHome } from '../gateway.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { canonicalPath, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import {
  defaultRelayStoreFiles,
  RELAY_IGNORED_NOTE,
  RELAY_SAVE_REFUSAL,
  TEST_RELAY_ACCOUNT_HOME_KEY,
} from '../relay-location.ts'
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

/** A migrated local OpenCode store in `dir`, with a relay saved in it. */
async function storeWithRelay(dir: string) {
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
  await runtime.updateRelay(RELAY)
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

test('a failed account lookup ignores the relay', async () => {
  const home = await scratch('relay-home-')
  const { runtime } = await storeWithRelay(join(home, '.config', 'opencode'))
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => undefined
  expect(await runtime.getRelayConfig()).toBeNull()
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = async () => {
    throw new Error('lookup failed')
  }
  expect(await runtime.getRelayConfig()).toBeNull()
})

test('with no test hook set, the check runs: a temporary store never supplies a relay', async () => {
  const elsewhere = await scratch('relay-moved-')
  const { runtime } = await storeWithRelay(join(elsewhere, 'opencode'))
  delete hook[TEST_RELAY_ACCOUNT_HOME_KEY]
  expect(await runtime.getRelayConfig()).toBeNull()
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
        const output = outputs[file]
        if (output === undefined || output instanceof Error)
          throw output ?? new Error('not found')
        return output
      },
      readFile: async () => '',
    },
  }
}

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
  const reg = 'C:\\Windows\\System32\\reg.exe'
  const windows = lookup('win32', {
    [reg]:
      '\r\nHKEY_CURRENT_USER\\Volatile Environment\r\n    USERPROFILE    REG_SZ    C:\\Users\\me\r\n\r\n',
  })
  expect(await lookupAccountHome(windows.dependencies)).toBe('C:\\Users\\me')
  expect(windows.calls).toEqual([
    {
      file: reg,
      args: ['query', 'HKCU\\Volatile Environment', '/v', 'USERPROFILE'],
    },
  ])
  for (const output of [
    '    USERPROFILE    REG_SZ    %SystemDrive%\\Users\\me\r\n',
    '    USERPROFILE    REG_SZ    Users\\me\r\n',
    new Error('denied'),
  ])
    expect(
      await lookupAccountHome(lookup('win32', { [reg]: output }).dependencies),
    ).toBeUndefined()
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
