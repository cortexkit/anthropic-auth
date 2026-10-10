import { expect } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import { lockPathFor, writeJsonAtomic } from '@cortexkit/common-auth/fs'
import type { NativeCustodyInventory } from '../native-custody.ts'
import {
  type NativeMigrationOptions,
  prepareNativeMigration,
  runNativeMigration,
} from '../native-migration.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  buildNativeVaultRosterSeed,
  validateNativeVaultRosterSeed,
} from '../native-roster-seed.ts'
import { readNativeRuntime, updateNativeRuntime } from '../native-runtime.ts'
import {
  readNativeMigrationJournal,
  requireNativePoolAuthority,
} from '../pool-authority.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const oauth = {
  type: 'oauth' as const,
  access: 'synthetic-access-main',
  refresh: 'synthetic-refresh-main',
  expires: 2000,
}
async function fixture(
  host: 'opencode' | 'pi' = 'opencode',
  hostEntry: unknown = oauth,
  routing = false,
) {
  const created = await mkdtemp(join(tmpdir(), 'native-offline-migration-'))
  deferCleanup(() => rm(created, { recursive: true, force: true }))
  const root = await realpath(created)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const input: NativeMigrationOptions = {
    paths,
    host,
    hostAuthPath: join(root, 'host-auth.json'),
    routingSourcePath: join(root, 'legacy-routing.json'),
    routingDestinationPath: join(root, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: true,
  }
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({
      version: 1,
      mainAccountId: 'primary-route',
      fallbackOn: [],
      accounts: [
        {
          id: 'fallback-route',
          type: 'oauth',
          enabled: false,
          label: 'Disabled account',
        },
      ],
      costZeroing: { enabled: false },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({
      version: 1,
      accounts: {
        'fallback-route': {
          access: 'synthetic-access-fallback',
          refresh: 'synthetic-refresh-fallback',
          expires: 4000,
          lastUsed: 50,
        },
      },
    }),
    { mode: 0o600 },
  )
  if (hostEntry !== undefined)
    await writeFile(
      input.hostAuthPath,
      JSON.stringify({
        anthropic: hostEntry,
        other: { key: 'synthetic-other-provider' },
      }),
      { mode: 0o600 },
    )
  if (routing)
    await writeFile(
      input.routingSourcePath,
      JSON.stringify({ version: 1, updatedAt: 10, assignments: {} }),
      { mode: 0o600 },
    )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  return { root, input, paths, store }
}

async function stopAt(input: NativeMigrationOptions, point: string) {
  await expect(
    runNativeMigration(input, {
      onStep: async (step) => {
        if (step === point) throw new Error('synthetic interruption')
      },
    }),
  ).rejects.toThrow()
}
async function expireChildLocks(root: string) {
  for (const name of await readdir(root)) {
    if (!name.endsWith('.lock')) continue
    const path = join(root, name)
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      !('ownerId' in value) ||
      !('expiresAt' in value)
    )
      continue
    await writeFile(path, JSON.stringify({ ...value, expiresAt: 0 }))
  }
}

test('offline transaction imports actual source, commits and retires in the same invocation', async () => {
  const { input, paths, store } = await fixture('opencode', oauth, true)
  const journal = await runNativeMigration(input)
  expect(journal.phase).toBe('retired')
  await requireNativePoolAuthority(paths)
  const rows = await store.read()
  expect(rows).toMatchObject({
    status: 'ready',
    rows: [
      { id: 'primary-route', stamp: 'bound' },
      { id: 'fallback-route', enabled: false, stamp: 'bound' },
    ],
  })
  expect(await store.readSettings()).toMatchObject({
    settings: {
      fallbackOn: [],
      costZeroing: { enabled: false },
      formerMainRowId: 'primary-route',
    },
  })
  expect(await readNativeRuntime(paths.runtime, paths.storageId)).toMatchObject(
    {
      status: 'ready',
      state: { accounts: { 'fallback-route': { lastUsed: 50 } } },
    },
  )
  for (const path of [
    paths.legacyConfig,
    paths.legacyState,
    input.routingSourcePath,
  ])
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  const text = await readFile(paths.journal, 'utf8')
  for (const secret of [
    oauth.access,
    oauth.refresh,
    'synthetic-refresh-fallback',
  ])
    expect(text).not.toContain(secret)
  expect((await stat(paths.journal)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(input.hostAuthPath, 'utf8')).other).toEqual({
    key: 'synthetic-other-provider',
  })
})

test('preflight conflicts and unaccounted native material publish no journal', async () => {
  for (const pathName of ['config', 'state', 'runtime', 'roster'] as const) {
    const { input, paths } = await fixture()
    await writeFile(paths[pathName], '{}', { mode: 0o600 })
    await expect(prepareNativeMigration(input)).rejects.toMatchObject({
      code: 'invalid-source',
    })
    await expect(stat(paths.journal)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(paths[pathName], 'utf8')).toBe('{}')
  }
  const { input, paths } = await fixture()
  const bytes = JSON.stringify({
    accounts: [
      { id: 'one', type: 'oauth', refresh: 'same' },
      { id: 'two', type: 'oauth', refresh: 'same' },
    ],
  })
  await writeFile(paths.legacyConfig, bytes)
  await expect(runNativeMigration(input)).rejects.toMatchObject({
    code: 'invalid-source',
  })
  expect(await readNativeMigrationJournal(paths)).toBeUndefined()
})

test('stock OpenCode API remains host-owned; Pi API-primary is never imported and requires explicit consent', async () => {
  const stock = await fixture('opencode', {
    type: 'api',
    key: 'synthetic-stock-key',
  })
  const bytes = await readFile(stock.input.hostAuthPath, 'utf8')
  await runNativeMigration(stock.input)
  expect(await readFile(stock.input.hostAuthPath, 'utf8')).toBe(bytes)
  expect(await stock.store.read()).toMatchObject({
    rows: [{ id: 'fallback-route' }],
  })
  for (const entry of [
    { type: 'api_key' },
    { type: 'api_key', env: { ANTHROPIC_API_KEY: 'SYNTHETIC_ENV' } },
    { type: 'api_key', key: 'synthetic-pi-key' },
  ]) {
    const pi = await fixture('pi', entry)
    await expect(
      runNativeMigration({ ...pi.input, removePiAnthropicAuth: false }),
    ).rejects.toMatchObject({ code: 'consent-required' })
    expect(await readNativeMigrationJournal(pi.paths)).toBeUndefined()
    await runNativeMigration(pi.input)
    expect(await pi.store.read()).toMatchObject({
      rows: [{ id: 'fallback-route' }],
    })
    expect(JSON.parse(await readFile(pi.input.hostAuthPath, 'utf8'))).toEqual({
      other: { key: 'synthetic-other-provider' },
    })
  }
})

test('prepared recovery accepts serialization-only rewrites and unrelated provider changes', async () => {
  const { input, paths } = await fixture()
  await stopAt(input, 'after:host')
  for (const path of [paths.config, paths.state, paths.runtime]) {
    const value: Record<string, unknown> = JSON.parse(
      await readFile(path, 'utf8'),
    )
    await writeFile(
      path,
      JSON.stringify(Object.fromEntries(Object.entries(value).reverse())),
      { mode: 0o600 },
    )
  }
  const host = JSON.parse(await readFile(input.hostAuthPath, 'utf8'))
  await writeFile(
    input.hostAuthPath,
    JSON.stringify({ ...host, newProvider: { key: 'synthetic-new-provider' } }),
  )
  expect((await runNativeMigration(input)).phase).toBe('retired')
  expect(
    JSON.parse(await readFile(input.hostAuthPath, 'utf8')).newProvider,
  ).toEqual({ key: 'synthetic-new-provider' })
})

test('prepared host-replacement recovery refuses public descriptor, epoch, identity and runtime drift with zero further writes', async () => {
  for (const change of [
    'access',
    'expires',
    'lastRefreshedAt',
    'refresh',
    'identity',
    'epoch',
    'runtime',
    'missing-proof',
  ]) {
    const { root, input, paths, store } = await fixture()
    await stopAt(input, 'after:host')
    if (['access', 'expires', 'lastRefreshedAt', 'refresh'].includes(change)) {
      const state = JSON.parse(await readFile(paths.state, 'utf8'))
      state.accounts['primary-route'][change] = [
        'expires',
        'lastRefreshedAt',
      ].includes(change)
        ? 3
        : 'synthetic-changed'
      await writeFile(paths.state, JSON.stringify(state))
    } else if (change === 'identity') {
      await store.recordIdentity(
        'primary-route',
        'synthetic-changed-identity',
        { credentialEpoch: 1 },
      )
    } else if (change === 'epoch') {
      await store.remove('primary-route')
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'pool-authority-crash-child.ts'),
          root,
          'native-readd',
          'before-write',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      deferCleanup(async () => {
        if (child.exitCode === null) child.kill()
        await child.exited
      })
      expect({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      }).toEqual({ code: 0, stderr: '' })
    } else if (change === 'runtime') {
      const runtime = JSON.parse(await readFile(paths.runtime, 'utf8'))
      runtime.accounts['primary-route'].lastUsed = 99
      await writeFile(paths.runtime, JSON.stringify(runtime))
    } else {
      const journal = JSON.parse(await readFile(paths.journal, 'utf8'))
      journal.preparedProof = null
      await writeFile(paths.journal, JSON.stringify(journal))
    }
    const before = await Promise.all(
      [
        paths.journal,
        paths.config,
        paths.state,
        paths.runtime,
        input.hostAuthPath,
      ].map((path) => readFile(path, 'utf8')),
    )
    await expect(runNativeMigration(input)).rejects.toThrow()
    expect(
      await Promise.all(
        [
          paths.journal,
          paths.config,
          paths.state,
          paths.runtime,
          input.hostAuthPath,
        ].map((path) => readFile(path, 'utf8')),
      ),
    ).toEqual(before)
  }
})

test('lost migration and pool ownership fence physical host write and authority rename', async () => {
  for (const [pathName, name] of [
    ['journal', 'native-migration'],
    ['config', 'pool-config'],
    ['state', 'pool-state'],
    ['runtime', 'native-runtime'],
  ] as const) {
    const { input, paths } = await fixture()
    const host = await readFile(input.hostAuthPath, 'utf8')
    await expect(
      runNativeMigration(input, {
        onStep: async (step) => {
          if (step !== 'before:host') return
          const path = lockPathFor(paths[pathName], name)
          const lease = JSON.parse(await readFile(path, 'utf8'))
          await writeFile(
            path,
            JSON.stringify({ ...lease, ownerId: 'synthetic-other-owner' }),
          )
        },
      }),
    ).rejects.toThrow()
    expect(await readFile(input.hostAuthPath, 'utf8')).toBe(host)
    expect((await readNativeMigrationJournal(paths))?.phase).toBe('verified')
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'migration-incomplete',
    })
  }
})

test('committed retirement ignores prepared proof after legitimate serving writes and repairs host without importing', async () => {
  const { input, paths, store } = await fixture()
  await stopAt(input, 'after-write:journal:committed')
  await store.rotate('primary-route', {
    ...oauth,
    access: 'synthetic-serving-access',
  })
  const before = await readFile(paths.state, 'utf8')
  await writeFile(
    input.hostAuthPath,
    JSON.stringify({
      anthropic: { ...oauth, access: 'synthetic-host-relogin' },
      other: { key: 'synthetic-other' },
    }),
  )
  expect((await runNativeMigration(input)).phase).toBe('retired')
  expect(await readFile(paths.state, 'utf8')).toBe(before)
  expect(await readFile(input.hostAuthPath, 'utf8')).not.toContain(
    'synthetic-host-relogin',
  )
})

test('changed retirement source remains untouched and authority remains committed', async () => {
  const { input, paths } = await fixture()
  await stopAt(input, 'after-write:journal:committed')
  const changed = '{"version":1,"accounts":[],"changed":true}'
  await writeFile(paths.legacyState, changed)
  await expect(runNativeMigration(input)).rejects.toMatchObject({
    code: 'retirement-refused',
  })
  expect(await readFile(paths.legacyState, 'utf8')).toBe(changed)
  expect((await readNativeMigrationJournal(paths))?.phase).toBe('committed')
  await requireNativePoolAuthority(paths)
})

test('fresh all-absent install reaches retired without fabricating a credential', async () => {
  const { input, paths, store } = await fixture()
  await Promise.all(
    [paths.legacyConfig, paths.legacyState, input.hostAuthPath].map((path) =>
      rm(path),
    ),
  )
  expect((await runNativeMigration(input)).phase).toBe('retired')
  expect(await store.read()).toMatchObject({ status: 'ready', rows: [] })
  expect((await readNativeMigrationJournal(paths))?.sources).toEqual({
    config: null,
    state: null,
    routing: null,
    hostAuth: 'absent',
  })
  expect(await readNativeRuntime(paths.runtime, paths.storageId)).toMatchObject(
    { status: 'ready', state: { accounts: {} } },
  )
})

test('prepared authority rename rechecks proof and ownership after host effect', async () => {
  for (const change of ['runtime', 'migration', 'pool']) {
    const { input, paths } = await fixture()
    await expect(
      runNativeMigration(input, {
        onStep: async (step) => {
          if (step !== 'before-write:journal:committed') return
          if (change === 'runtime') {
            const value = JSON.parse(await readFile(paths.runtime, 'utf8'))
            value.accounts['primary-route'].lastUsed = 321
            await writeFile(paths.runtime, JSON.stringify(value))
          } else {
            const path = lockPathFor(
              change === 'pool' ? paths.config : paths.journal,
              change === 'pool' ? 'pool-config' : 'native-migration',
            )
            const value = JSON.parse(await readFile(path, 'utf8'))
            await writeFile(
              path,
              JSON.stringify({ ...value, ownerId: 'synthetic-successor' }),
            )
          }
        },
      }),
    ).rejects.toThrow()
    expect((await readNativeMigrationJournal(paths))?.phase).toBe(
      'activation-installed',
    )
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'migration-incomplete',
    })
  }
})

test('prepared API endpoint and header changes refuse even with a valid new public stamp', async () => {
  for (const change of [
    { baseURL: 'https://changed.invalid' },
    { authHeader: 'x-api-key' as const },
  ]) {
    const { input, paths, store } = await fixture()
    const api = {
      type: 'api' as const,
      apiKey: 'synthetic-api-fallback',
      baseURL: 'https://original.invalid',
      authHeader: 'authorization-bearer' as const,
    }
    await writeFile(
      paths.legacyConfig,
      JSON.stringify({
        mainAccountId: 'primary-route',
        accounts: [{ id: 'api-route', ...api }],
      }),
    )
    await stopAt(input, 'after:host')
    await store.replace('api-route', { ...api, ...change })
    const journal = await readFile(paths.journal, 'utf8')
    await expect(runNativeMigration(input)).rejects.toMatchObject({
      code: 'prepared-proof-refused',
    })
    expect(await readFile(paths.journal, 'utf8')).toBe(journal)
  }
})

test('prepared disabled intent remains fenced after host replacement with unchanged credentials', async () => {
  const { input, paths, store } = await fixture()
  await stopAt(input, 'after:host')
  await store.enable('fallback-route')
  const before = await readFile(paths.journal, 'utf8')
  await expect(runNativeMigration(input)).rejects.toMatchObject({
    code: 'prepared-proof-refused',
  })
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
})

test('retired setup preserves serving-owned routing changes and imports no host relogin', async () => {
  const { input, paths, store } = await fixture('opencode', oauth, true)
  await runNativeMigration(input)
  const routing = '{"version":1,"updatedAt":999,"assignments":{}}'
  await writeFile(input.routingDestinationPath, routing)
  await store.rotate('primary-route', {
    ...oauth,
    access: 'synthetic-legitimate-access',
  })
  const before = await Promise.all(
    [paths.config, paths.state, paths.runtime, paths.journal].map((path) =>
      readFile(path, 'utf8'),
    ),
  )
  await writeFile(
    input.hostAuthPath,
    JSON.stringify({
      anthropic: { ...oauth, access: 'synthetic-unimported-login' },
    }),
  )
  await runNativeMigration(input)
  expect(await readFile(input.routingDestinationPath, 'utf8')).toBe(routing)
  expect(
    await Promise.all(
      [paths.config, paths.state, paths.runtime, paths.journal].map((path) =>
        readFile(path, 'utf8'),
      ),
    ),
  ).toEqual(before)
})

async function custodyFixture() {
  const result = await fixture()
  await writeFile(
    result.paths.legacyConfig,
    JSON.stringify({
      mainAccountId: 'primary-route',
      claustrum: {
        mode: 'claustrum',
        primaryAccount: {
          credentialId: 'oauth:anthropic',
          accountId: 'primary-identity',
          state: 'active',
        },
      },
      accounts: [
        {
          id: 'vault-fallback',
          type: 'oauth',
          refresh: '',
          enabled: false,
          claustrumScopedCredentialId: 'oauth:secondary',
          anthropicAccountUuid: 'secondary-identity',
        },
        {
          id: 'api-route',
          type: 'api',
          apiKey: 'synthetic-api-fallback',
          baseURL: 'https://synthetic.invalid',
        },
      ],
    }),
  )
  await writeFile(
    result.paths.legacyState,
    JSON.stringify({
      version: 1,
      accounts: {
        'vault-fallback': {
          claustrumScopedCredentialId: 'oauth:secondary',
          anthropicAccountUuid: 'secondary-identity',
          lastUsed: 100,
          quota: {
            accountIdentity: 'secondary-identity',
            checkedAt: 50,
            scoped: [],
          },
        },
      },
    }),
  )
  const inventory: { value: NativeCustodyInventory } = {
    value: {
      view: 'synthetic-view-one',
      skipped: [],
      credentials: [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: 'primary-identity',
          state: 'active',
        },
        {
          credentialId: 'oauth:secondary',
          credentialType: 'oauth',
          accountIdentity: 'secondary-identity',
          state: 'active',
        },
      ],
    },
  }
  result.input.custody = {
    discover: async () => inventory.value,
    // These injected file writers test the controller's resume sequence without
    // a daemon. Host tests must also use the real vault publishers to verify
    // lock ownership immediately before the shared store replaces each file.
    publishSeed: async (paths, input, options) => {
      const seed = buildNativeVaultRosterSeed(input)
      const existing = await readVaultRoster(paths.roster)
      if (existing) {
        validateNativeVaultRosterSeed(existing, input)
        return seed
      }
      await writeJsonAtomic(paths.roster, seed, {
        beforeRename: options.assertOwned,
      })
      return seed
    },
    publishRuntimeSeed: async (paths, state, options) => {
      await updateNativeRuntime(paths.runtime, paths.storageId, () => state, {
        beforeRename: options.assertOwned,
      })
    },
  }
  return { ...result, inventory }
}

test('custody consumes durable seed and runtime publication seams without importing OAuth secrets', async () => {
  const { input, paths, store } = await custodyFixture()
  expect((await runNativeMigration(input)).phase).toBe('retired')
  expect(await store.read()).toMatchObject({
    rows: [{ id: 'api-route', stamp: 'bound' }],
  })
  const runtime = await readNativeRuntime(paths.runtime, paths.storageId)
  expect(runtime).toMatchObject({
    status: 'ready',
    state: {
      accounts: {
        'vault-fallback': {
          lastUsed: 100,
          binding: { credentialId: 'oauth:secondary', recordVersion: 0 },
          quota: { anthropic: { scoped: [] } },
        },
      },
    },
  })
  for (const path of [
    paths.runtime,
    paths.roster,
    paths.state,
    paths.journal,
  ]) {
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(oauth.access)
    expect(text).not.toContain(oauth.refresh)
  }
})

test('custody seed resume retains published bytes after inventory view/state changes', async () => {
  const { input, paths, inventory } = await custodyFixture()
  await stopAt(input, 'after:roster')
  const original = await readFile(paths.roster, 'utf8')
  inventory.value = {
    ...inventory.value,
    view: 'synthetic-view-two',
    credentials: inventory.value.credentials.map((row) => ({
      ...row,
      state: 'cold',
    })),
  }
  expect((await runNativeMigration(input)).phase).toBe('retired')
  expect(await readFile(paths.roster, 'utf8')).toBe(original)
})

test('custody publication receives final migration assertion and refuses a successor owner', async () => {
  const { input, paths } = await custodyFixture()
  if (!input.custody) throw new Error('Missing synthetic custody fixture')
  input.custody.publishSeed = async (paths, seedInput, options) => {
    const lock = lockPathFor(paths.journal, 'native-migration')
    const value = JSON.parse(await readFile(lock, 'utf8'))
    await writeFile(
      lock,
      JSON.stringify({ ...value, ownerId: 'synthetic-successor' }),
    )
    const seed = buildNativeVaultRosterSeed(seedInput)
    await writeJsonAtomic(paths.roster, seed, {
      beforeRename: options.assertOwned,
    })
    return seed
  }
  await expect(runNativeMigration(input)).rejects.toMatchObject({
    code: 'ownership-lost',
  })
  await expect(stat(paths.roster)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readNativeMigrationJournal(paths))?.phase).toBe('building')
  expect(await readFile(input.hostAuthPath, 'utf8')).toContain(oauth.access)
})

test('selected-host preflight tokens refuse later drift before second host begin', async () => {
  const first = await fixture('opencode')
  const second = await fixture('pi')
  first.input.preflight = await prepareNativeMigration(first.input)
  second.input.preflight = await prepareNativeMigration(second.input)
  await runNativeMigration(first.input)
  await writeFile(second.paths.legacyState, '{"version":1,"changed":true}')
  await expect(runNativeMigration(second.input)).rejects.toMatchObject({
    code: 'invalid-source',
  })
  expect(await readNativeMigrationJournal(second.paths)).toBeUndefined()
  expect((await readNativeMigrationJournal(first.paths))?.phase).toBe('retired')
})

const crashCases: Array<[string, 'opencode' | 'pi']> = [
  ['before-write:journal:building', 'opencode'],
  ['after-state-write:store:add', 'opencode'],
  ['after:runtime', 'opencode'],
  ['before-write:proof', 'opencode'],
  ['after-write:proof', 'opencode'],
  ['after:routing', 'opencode'],
  ['host:before-rename', 'opencode'],
  ['host:after-rename', 'opencode'],
  ['after-write:journal:activation-installed', 'opencode'],
  ['before-write:journal:committed', 'opencode'],
  ['after-write:journal:committed', 'opencode'],
  ['after:retire:config', 'opencode'],
  ['after-write:journal:retired', 'opencode'],
  ['host:after-unlink', 'pi'],
]
for (const [point, host] of crashCases)
  test(`real child crash-forward recovery at ${host} ${point}`, async () => {
    const { root, input, paths, store } = await fixture(host, oauth, true)
    if (point === 'host:after-unlink')
      await writeFile(input.hostAuthPath, JSON.stringify({ anthropic: oauth }))
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'pool-authority-crash-child.ts'),
        root,
        'native-controller',
        point,
        host,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    deferCleanup(async () => {
      if (child.exitCode === null) child.kill()
      await child.exited
    })
    const code = await child.exited
    const stderr = await new Response(child.stderr).text()
    expect({ point, code, stderr }).toEqual({ point, code: 19, stderr: '' })
    const journal = await readNativeMigrationJournal(paths)
    if (
      !journal ||
      (journal.phase !== 'committed' && journal.phase !== 'retired')
    )
      await expect(requireNativePoolAuthority(paths)).rejects.toThrow()
    await expireChildLocks(root)
    expect((await runNativeMigration(input)).phase).toBe('retired')
    await requireNativePoolAuthority(paths)
    const rows = await store.read()
    expect(rows).toMatchObject({
      rows: [
        {
          id: 'primary-route',
          stamp: 'bound',
          credential: { refresh: oauth.refresh },
        },
        { id: 'fallback-route', enabled: false },
      ],
    })
    if (point === 'host:after-unlink')
      await expect(stat(input.hostAuthPath)).rejects.toMatchObject({
        code: 'ENOENT',
      })
  })
