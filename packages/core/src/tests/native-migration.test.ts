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
import {
  mutateVaultRoster,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import {
  LockContentionError,
  lockPathFor,
  withLock,
  writeJsonAtomic,
} from '@cortexkit/common-auth/fs'
import type { ProviderAccountUuid } from '../claude-code.ts'
import { custodyTombstoneOAuth } from '../claustrum.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeAccountView } from '../native-account-view.ts'
import type { NativeCustodyInventory } from '../native-custody.ts'
import {
  NativeMigrationError,
  type NativeMigrationOptions,
  nativePoolHoldsAccountData,
  prepareNativeMigration,
  publishNativeEmptyInit,
  runNativeMigration,
  snapshotHasServableLocalOAuth,
} from '../native-migration.ts'
import { nativeMigrationDigest } from '../native-migration-proof.ts'
import { projectNativeMigrationSource } from '../native-migration-source.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  buildNativeVaultRosterSeed,
  validateNativeVaultRosterSeed,
} from '../native-roster-seed.ts'
import { readNativeRuntime, updateNativeRuntime } from '../native-runtime.ts'
import { writeNativeSetupSettings } from '../native-setup-settings.ts'
import {
  NativeAuthorityError,
  readNativeMigrationJournal,
  requireNativePoolAuthority,
} from '../pool-authority.ts'
import {
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
} from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { resolveSettingsPaths } from '../settings-paths.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
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

async function emptyFixture() {
  const f = await fixture()
  f.input.routingDestinationPath = resolveLocalRoutingDestination(
    'opencode',
    f.paths,
    {},
  )
  return f
}

async function fileBytes(
  f: Pick<Awaited<ReturnType<typeof fixture>>, 'input' | 'paths'>,
) {
  return Promise.all(
    [
      f.paths.config,
      f.paths.state,
      f.paths.runtime,
      f.paths.roster,
      f.paths.journal,
      f.paths.legacyConfig,
      f.paths.legacyState,
      f.input.hostAuthPath,
      f.input.routingSourcePath,
      f.input.routingDestinationPath,
    ].map(async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null
        throw error
      }
    }),
  )
}

async function expectRefusal(
  work: Promise<unknown>,
  type: typeof NativeMigrationError | typeof NativeAuthorityError,
  code: string,
) {
  const error = await work.catch((error) => error)
  expect({
    instance: error instanceof type,
    name: error instanceof Error ? error.name : undefined,
    code: error instanceof Error && 'code' in error ? error.code : undefined,
  }).toMatchObject({ instance: true })
  expect(
    error instanceof Error && 'code' in error ? error.code : undefined,
  ).toBe(code)
}

test('empty-init publishes only authority and repeats byte-identically after native writes', async () => {
  const f = await emptyFixture()
  const before = await fileBytes(f)
  const journal = await publishNativeEmptyInit(f.input)
  expect(journal).toEqual({
    version: 5,
    kind: 'empty-init',
    storageId: f.paths.storageId,
    host: 'opencode',
    phase: 'committed',
  })
  const published = await fileBytes(f)
  expect(published.map((value, index) => (index === 4 ? null : value))).toEqual(
    before,
  )
  expect((await stat(f.paths.journal)).mode & 0o777).toBe(0o600)
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { env: {} },
    local: {
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid:
          '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid,
      }),
    },
  })
  deferCleanup(() => runtime.close())
  expect((await runtime.read()).mode).toBe('local')
  await runtime.loginOAuth({
    routeId: 'main',
    credential: {
      ...oauth,
      access: 'sk-ant-oat01-synthetic-empty-init',
      expires: Date.now() + 3_600_000,
    },
  })
  await writeFile(f.input.routingDestinationPath, 'native pins', {
    mode: 0o600,
  })
  const populated = await fileBytes(f)
  let writes = 0
  expect(
    await publishNativeEmptyInit(f.input, {
      onStep: async () => {
        writes++
      },
    }),
  ).toEqual(journal)
  expect(writes).toBe(0)
  expect(await fileBytes(f)).toEqual(populated)
})

test('empty-init waits on each existing journal lease and times out without writes', async () => {
  for (const name of ['native-migration', 'migration-journal']) {
    const f = await emptyFixture()
    const before = await fileBytes(f)
    const ready = gate()
    const release = gate()
    const holder = withLock(
      f.paths.journal,
      { name, ttlMs: 30_000, timeoutMs: 100, renew: true },
      async () => {
        ready.open()
        await release.wait
      },
    )
    trackDetached(holder)
    try {
      await ready.wait
      const error = await publishNativeEmptyInit(f.input, {
        lockOptions: { ttlMs: 30_000, timeoutMs: 30 },
      }).catch((error) => error)
      expect(error).toBeInstanceOf(LockContentionError)
      expect(error.details).toEqual({
        target: f.paths.journal,
        name,
        timeoutMs: 30,
      })
      expect(await fileBytes(f)).toEqual(before)
    } finally {
      release.open()
      await Promise.allSettled([holder])
    }
  }
})

test('empty-init takes no pool locks and never enters the roster mutation', async () => {
  const f = await emptyFixture()
  const release = gate()
  const locks = [
    [f.paths.config, 'pool-config'],
    [f.paths.state, 'pool-state'],
    [f.paths.runtime, 'native-runtime'],
  ] as const
  const ready = locks.map(() => gate())
  const holders = locks.map(([path, name], index) =>
    withLock(
      path,
      { name, ttlMs: 30_000, timeoutMs: 100, renew: true },
      async () => {
        ready[index]!.open()
        await release.wait
      },
    ),
  )
  const rosterReady = gate()
  holders.push(
    mutateVaultRoster(f.paths.roster, async () => {
      rosterReady.open()
      await release.wait
      return { result: undefined }
    }),
  )
  for (const holder of holders) trackDetached(holder)
  try {
    await Promise.all(ready.map((item) => item.wait))
    await rosterReady.wait
    await publishNativeEmptyInit(f.input, {
      lockOptions: { ttlMs: 30_000, timeoutMs: 30 },
    })
    expect(await readNativeMigrationJournal(f.paths)).toMatchObject({
      kind: 'empty-init',
    })
    await expect(stat(f.paths.roster)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    release.open()
    await Promise.allSettled(holders)
  }
})

test('empty-init lost lease before rename leaves no journal, native file or POSIX temp', async () => {
  const f = await emptyFixture()
  const before = await fileBytes(f)
  await expectRefusal(
    publishNativeEmptyInit(f.input, {
      onStep: async (step) => {
        if (step !== 'before-write:journal:committed') return
        const path = lockPathFor(f.paths.journal, 'native-migration')
        const lease = JSON.parse(await readFile(path, 'utf8'))
        await writeFile(
          path,
          JSON.stringify({ ...lease, ownerId: 'other-owner' }),
        )
      },
    }),
    NativeMigrationError,
    'ownership-lost',
  )
  expect(await fileBytes(f)).toEqual(before)
  if (process.platform !== 'win32')
    expect(
      (await readdir(f.root)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([])
})

test('empty-init enrollment fence precedes reads and repeats before rename', async () => {
  const f = await emptyFixture()
  const before = await fileBytes(f)
  const vault = new Error('Disconnect from the vault first.')
  await expect(
    publishNativeEmptyInit({
      ...f.input,
      processFence: async () => {
        throw vault
      },
    }),
  ).rejects.toBe(vault)
  expect(await fileBytes(f)).toEqual(before)
  let enrolled = false
  await expect(
    publishNativeEmptyInit(
      {
        ...f.input,
        processFence: async () => {
          if (enrolled) throw vault
        },
      },
      {
        onStep: async (step) => {
          if (step === 'before-write:journal:committed') {
            enrolled = true
            const path = lockPathFor(f.paths.journal, 'native-migration')
            const lease = JSON.parse(await readFile(path, 'utf8'))
            await writeFile(
              path,
              JSON.stringify({ ...lease, ownerId: 'other-owner' }),
            )
          }
        },
      },
    ),
  ).rejects.toBe(vault)
  expect(await fileBytes(f)).toEqual(before)
  await writeFile(f.paths.journal, '{bad', { mode: 0o600 })
  await expect(
    publishNativeEmptyInit({
      ...f.input,
      processFence: async () => {
        throw vault
      },
    }),
  ).rejects.toBe(vault)
  expect(await readFile(f.paths.journal, 'utf8')).toBe('{bad')
})

test('empty-init refuses existing destinations including a file created before rename', async () => {
  for (const key of [
    'config',
    'state',
    'runtime',
    'roster',
    'routing',
  ] as const) {
    for (const late of [false, true]) {
      const f = await emptyFixture()
      const path =
        key === 'routing' ? f.input.routingDestinationPath : f.paths[key]
      if (!late)
        await writeFile(path, 'pre-existing native bytes', { mode: 0o600 })
      const before = await fileBytes(f)
      await expectRefusal(
        publishNativeEmptyInit(f.input, {
          onStep: async (step) => {
            if (late && step === 'before-write:journal:committed')
              await writeFile(path, 'external native bytes', { mode: 0o600 })
          },
        }),
        NativeMigrationError,
        'invalid-source',
      )
      expect(await readFile(path, 'utf8')).toBe(
        late ? 'external native bytes' : 'pre-existing native bytes',
      )
      const expected = [...before]
      if (late)
        expected[
          key === 'routing'
            ? 9
            : ['config', 'state', 'runtime', 'roster'].indexOf(key)
        ] = 'external native bytes'
      expect(await fileBytes(f)).toEqual(expected)
      expect(await readNativeMigrationJournal(f.paths)).toBeUndefined()
    }
  }
})

test('empty-init refuses unsafe destination stats and canonical aliases without writes', async () => {
  const f = await emptyFixture()
  const before = await fileBytes(f)
  const blocker = join(f.root, 'not-a-directory')
  await writeFile(blocker, 'blocker')
  await expectRefusal(
    publishNativeEmptyInit({
      ...f.input,
      paths: { ...f.paths, config: join(blocker, 'child') },
    }),
    NativeMigrationError,
    'unsafe-source',
  )
  await expectRefusal(
    publishNativeEmptyInit({
      ...f.input,
      routingDestinationPath: f.paths.legacyConfig,
      env: { OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: f.paths.legacyConfig },
    }),
    NativeMigrationError,
    'invalid-source',
  )
  expect(await fileBytes(f)).toEqual(before)
})

test('empty-init preserves overridden and legacy-derived routing files', async () => {
  for (const override of [false, true]) {
    const f = await emptyFixture()
    const legacy = resolveLocalRoutingDestination(
      'opencode',
      { ...f.paths, config: f.paths.legacyConfig },
      {},
    )
    const shared = join(f.root, 'shared-routing.json')
    await writeFile(legacy, 'legacy pins', { mode: 0o600 })
    if (override) {
      f.input.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE = shared
      f.input.routingDestinationPath = shared
      await writeFile(shared, 'shared pins', { mode: 0o600 })
    }
    await publishNativeEmptyInit(f.input)
    expect(await readFile(legacy, 'utf8')).toBe('legacy pins')
    if (override) expect(await readFile(shared, 'utf8')).toBe('shared pins')
    const runtime = createNativeAccountRuntime({
      paths: f.paths,
      host: 'opencode',
      vault: { env: f.input.env },
    })
    deferCleanup(() => runtime.close())
    expect((await runtime.read()).routingPath).toBe(
      f.input.routingDestinationPath,
    )
  }
})

test('empty-init publication conflicts on every differing journal key and on legacy journals', async () => {
  const f = await emptyFixture()
  const journal = await publishNativeEmptyInit(f.input)
  for (const value of [
    { ...journal, version: 4 },
    { ...journal, kind: 'legacy-import' },
    { ...journal, host: 'pi' },
    { ...journal, storageId: '0'.repeat(64) },
    { ...journal, phase: 'retired' },
    { ...journal, extra: true },
  ]) {
    const bytes = JSON.stringify(value)
    await writeFile(f.paths.journal, bytes)
    const before = await fileBytes(f)
    await expectRefusal(
      publishNativeEmptyInit(f.input),
      NativeAuthorityError,
      'journal-conflict',
    )
    expect(await fileBytes(f)).toEqual(before)
  }
  const g = await fixture()
  await runNativeMigration(g.input)
  const before = await fileBytes(g)
  await expectRefusal(
    publishNativeEmptyInit(g.input),
    NativeAuthorityError,
    'journal-conflict',
  )
  expect(await fileBytes(g)).toEqual(before)
})

test('empty-init interruption before rename publishes on one new run; after rename retry is a no-op', async () => {
  for (const step of [
    'before-write:journal:committed',
    'after-write:journal:committed',
  ]) {
    const f = await emptyFixture()
    const before = await fileBytes(f)
    await expect(
      publishNativeEmptyInit(f.input, {
        onStep: async (current) => {
          if (current === step) throw new Error('synthetic interruption')
        },
      }),
    ).rejects.toThrow('synthetic interruption')
    const crashed = await fileBytes(f)
    if (step.startsWith('before')) expect(crashed).toEqual(before)
    else
      expect(await readNativeMigrationJournal(f.paths)).toMatchObject({
        kind: 'empty-init',
        phase: 'committed',
      })
    await publishNativeEmptyInit(f.input)
    const published = await fileBytes(f)
    if (step.startsWith('after')) expect(published).toEqual(crashed)
    await publishNativeEmptyInit(f.input, {
      onStep: async () => {
        throw new Error('must not write')
      },
    })
    expect(await fileBytes(f)).toEqual(published)
  }
})

test('empty-init imports later OC1 accounts and metadata, preserves preferences and gap-fills pins', async () => {
  const f = await emptyFixture()
  await publishNativeEmptyInit(f.input)
  await f.store.updateSettings(() => ({
    costZeroing: { enabled: true },
    routingMode: 'sticky',
    customPreference: { exact: [1, false] },
  }))
  const settings = await f.store.readSettings()
  const pin = (accountId: string) => ({
    accountId,
    family: 'general',
    assignedAt: 1,
    lastSeenAt: 2,
    initialInputBytes: 3,
    quotaCheckedAt: 0,
  })
  const nativePin = pin('native-route')
  await writeFile(
    f.input.routingDestinationPath,
    JSON.stringify({
      version: 1,
      updatedAt: 20,
      assignments: { A: nativePin },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    f.input.routingSourcePath,
    JSON.stringify({
      version: 1,
      updatedAt: 10,
      assignments: { A: pin('main'), B: pin('fallback-route') },
    }),
    { mode: 0o600 },
  )
  const config = JSON.parse(await readFile(f.paths.legacyConfig, 'utf8'))
  config.accounts[0].anthropicAccountUuid = 'fixture-uuid'
  await writeFile(f.paths.legacyConfig, JSON.stringify(config))
  const state = JSON.parse(await readFile(f.paths.legacyState, 'utf8'))
  state.accounts['fallback-route'] = {
    ...state.accounts['fallback-route'],
    profile: {
      tier: 'max',
      orgType: 'claude_max',
      checkedAt: 10,
      providerAccountUuid: 'fixture-uuid',
    },
    profileToken: tokenFingerprint('synthetic-access-fallback'),
    quotaToken: tokenFingerprint('synthetic-access-fallback'),
    quota: { accountIdentity: 'fixture-uuid', scoped: [] },
    prime: { count: 2, inputTokens: 3, outputTokens: 4, since: 1 },
  }
  await writeFile(f.paths.legacyState, JSON.stringify(state))
  let building = false
  const journal = await runNativeMigration(f.input, {
    onStep: async (step) => {
      if (step === 'after-write:journal:building') {
        building = true
        expect(await readNativeMigrationJournal(f.paths)).toMatchObject({
          version: 5,
          kind: 'legacy-import',
          phase: 'building',
          nativeSettingsDigest: nativeMigrationDigest(
            settings.status === 'ready' ? settings.settings : {},
          ),
        })
        expect(await f.store.read()).toMatchObject({ rows: [] })
      }
    },
  })
  expect(building).toBe(true)
  expect(journal).toMatchObject({
    version: 5,
    kind: 'legacy-import',
    phase: 'retired',
  })
  expect(await f.store.readSettings()).toEqual(settings)
  expect(await f.store.read()).toMatchObject({
    rows: [
      { id: 'primary-route' },
      { id: 'fallback-route', quota: { anthropic: { scoped: [] } } },
    ],
  })
  expect(
    await readNativeRuntime(f.paths.runtime, f.paths.storageId),
  ).toMatchObject({
    state: {
      accounts: {
        'fallback-route': {
          profile: { providerAccountUuid: 'fixture-uuid' },
          prime: { count: 2 },
        },
      },
    },
  })
  expect(
    JSON.parse(await readFile(f.input.routingDestinationPath, 'utf8'))
      .assignments,
  ).toEqual({ A: nativePin, B: pin('fallback-route') })
  await expect(stat(f.paths.legacyState)).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('direct migration refuses populated empty-init before any write for every host slot', async () => {
  for (const slot of [
    undefined,
    { type: 'api', key: 'synthetic-api' },
    custodyTombstoneOAuth('anthropic'),
    oauth,
  ]) {
    const f = await emptyFixture()
    await publishNativeEmptyInit(f.input)
    await f.store.add({
      id: 'native',
      credential: { ...oauth, refresh: 'native-refresh' },
    })
    if (slot === undefined) await rm(f.input.hostAuthPath)
    else
      await writeFile(f.input.hostAuthPath, JSON.stringify({ anthropic: slot }))
    const before = await fileBytes(f)
    await expectRefusal(
      runNativeMigration(f.input, {
        onStep: async () => {
          throw new Error(
            'capture must refuse before a journal write is attempted',
          )
        },
      }),
      NativeMigrationError,
      'pool-populated',
    )
    expect(await fileBytes(f)).toEqual(before)
  }
})

test('empty-init building owner check catches account data created after capture', async () => {
  const f = await emptyFixture()
  await publishNativeEmptyInit(f.input)
  const journal = await readFile(f.paths.journal, 'utf8')
  await expectRefusal(
    runNativeMigration(f.input, {
      onStep: async (step) => {
        if (step === 'before-write:journal:building')
          await f.store.add({ id: 'concurrent', credential: oauth })
      },
    }),
    NativeMigrationError,
    'pool-populated',
  )
  expect(await readFile(f.paths.journal, 'utf8')).toBe(journal)
  expect(await readFile(f.paths.legacyState, 'utf8')).toContain(
    'synthetic-refresh-fallback',
  )
})

test('empty-init imports every unpopulated host slot and absent sources install the placeholder', async () => {
  for (const slot of [
    undefined,
    { type: 'api', key: 'synthetic-api' },
    custodyTombstoneOAuth('anthropic'),
    oauth,
  ]) {
    const f = await emptyFixture()
    await publishNativeEmptyInit(f.input)
    if (slot === undefined) await rm(f.input.hostAuthPath)
    else
      await writeFile(f.input.hostAuthPath, JSON.stringify({ anthropic: slot }))
    await rm(f.paths.legacyConfig)
    await rm(f.paths.legacyState)
    const journal = await runNativeMigration(f.input)
    expect(journal).toMatchObject({
      version: 5,
      kind: 'legacy-import',
      phase: 'retired',
    })
    const auth = JSON.parse(
      await readFile(f.input.hostAuthPath, 'utf8'),
    ).anthropic
    expect(auth).toEqual(
      slot && slot.type === 'api' ? slot : custodyTombstoneOAuth('anthropic'),
    )
    if (slot !== oauth) expect(await f.store.read()).toMatchObject({ rows: [] })
    else {
      const pool = await f.store.read()
      if (pool.status !== 'ready') throw new Error('pool is not ready')
      expect(pool.rows).toHaveLength(1)
      expect(pool.rows[0]).toMatchObject({
        type: 'oauth',
        enabled: true,
        credential: { access: oauth.access, refresh: oauth.refresh },
      })
    }
  }
})

// Setups first run on 2.0.2 or earlier with no login left a retired v4 import
// of nothing instead of empty-init. A later OpenCode login is imported the
// same way while the pool holds no account data; session pins do not count.
async function retiredEmptyFixture() {
  const f = await fixture()
  for (const path of [
    f.paths.legacyConfig,
    f.paths.legacyState,
    f.input.hostAuthPath,
  ])
    await rm(path)
  expect(await runNativeMigration(f.input)).toMatchObject({
    version: 4,
    phase: 'retired',
    activation: null,
  })
  expect(await nativePoolHoldsAccountData(f)).toBe(false)
  return f
}

const laterLogin = {
  ...oauth,
  access: 'synthetic-later-host-login',
  refresh: 'synthetic-later-host-refresh',
}

async function expectLaterLoginImported(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const pool = await f.store.read()
  if (pool.status !== 'ready') throw new Error('pool is not ready')
  expect(pool.rows).toHaveLength(1)
  expect(pool.rows[0]).toMatchObject({
    type: 'oauth',
    enabled: true,
    credential: { access: laterLogin.access, refresh: laterLogin.refresh },
  })
}

test('retired import with no account data imports a later OpenCode login like empty-init', async () => {
  const f = await retiredEmptyFixture()
  const pins = {
    version: 1,
    updatedAt: 999,
    assignments: {
      'session-pinned': {
        accountId: 'main',
        family: 'general',
        assignedAt: 1,
        lastSeenAt: 1,
        initialInputBytes: 0,
        quotaCheckedAt: 1,
      },
    },
  }
  await writeFile(f.input.routingDestinationPath, JSON.stringify(pins))
  expect(await nativePoolHoldsAccountData(f)).toBe(false)
  await writeFile(
    f.input.hostAuthPath,
    JSON.stringify({ anthropic: laterLogin }),
  )
  const journal = await runNativeMigration(f.input)
  expect(journal).toMatchObject({
    version: 5,
    kind: 'legacy-import',
    phase: 'retired',
    activation: null,
  })
  expect(await readNativeMigrationJournal(f.paths)).toEqual(journal)
  await expectLaterLoginImported(f)
  // The login is moved, not copied: the host slot keeps no live token.
  const host = await readFile(f.input.hostAuthPath, 'utf8')
  expect(JSON.parse(host).anthropic).toEqual(custodyTombstoneOAuth('anthropic'))
  expect(host).not.toContain(laterLogin.refresh)
  expect(host).not.toContain(laterLogin.access)
  expect(
    JSON.parse(await readFile(f.input.routingDestinationPath, 'utf8'))
      .assignments,
  ).toEqual(pins.assignments)
})

// The placeholder replaces the host login only after the imported row is
// written and recorded in the verified journal. A crash on either side of the
// host write keeps the login in the pool or in the slot, and a rerun finishes.
test('retired import of a later OpenCode login survives a crash around the host write', async () => {
  for (const point of ['before:host', 'after:host']) {
    const f = await retiredEmptyFixture()
    await writeFile(
      f.input.hostAuthPath,
      JSON.stringify({ anthropic: laterLogin }),
    )
    await stopAt(f.input, point)
    expect(await readNativeMigrationJournal(f.paths)).toMatchObject({
      version: 5,
      kind: 'legacy-import',
      phase: 'verified',
    })
    await expectLaterLoginImported(f)
    expect(
      JSON.parse(await readFile(f.input.hostAuthPath, 'utf8')).anthropic,
    ).toEqual(
      point === 'before:host' ? laterLogin : custodyTombstoneOAuth('anthropic'),
    )
    expect(await runNativeMigration(f.input)).toMatchObject({
      version: 5,
      kind: 'legacy-import',
      phase: 'retired',
    })
    await expectLaterLoginImported(f)
    expect(
      JSON.parse(await readFile(f.input.hostAuthPath, 'utf8')).anthropic,
    ).toEqual(custodyTombstoneOAuth('anthropic'))
  }
})

test('retired import with account data refuses a later OpenCode login without writes', async () => {
  const f = await retiredEmptyFixture()
  await f.store.add({ id: 'native', credential: oauth })
  await writeFile(
    f.input.hostAuthPath,
    JSON.stringify({ anthropic: laterLogin }),
  )
  const before = await fileBytes(f)
  let writes = 0
  await expectRefusal(
    runNativeMigration(f.input, {
      onStep: async () => {
        writes++
      },
    }),
    NativeMigrationError,
    'host-login-present',
  )
  expect(writes).toBe(0)
  expect(await fileBytes(f)).toEqual(before)
})

test('v5 crash after account import resumes with exact settings or refuses changed settings without writes', async () => {
  for (const changed of [false, true, 'non-ready'] as const) {
    const f = await emptyFixture()
    await publishNativeEmptyInit(f.input)
    await f.store.updateSettings(() => ({ costZeroing: { enabled: true } }))
    const settings = await f.store.readSettings()
    await stopAt(f.input, 'after:add:primary-route')
    expect(await readNativeMigrationJournal(f.paths)).toMatchObject({
      kind: 'legacy-import',
      phase: 'building',
    })
    if (changed === true)
      await f.store.updateSettings(() => ({ costZeroing: { enabled: false } }))
    if (changed === 'non-ready') {
      const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
      config.commonAuthPool.schemaVersion = 999
      await writeFile(f.paths.config, JSON.stringify(config))
    }
    const before = await fileBytes(f)
    let writes = 0
    if (changed) {
      await expectRefusal(
        runNativeMigration(f.input, {
          onStep: async () => {
            writes++
          },
        }),
        NativeMigrationError,
        'settings-changed',
      )
      expect(writes).toBe(0)
      expect(await fileBytes(f)).toEqual(before)
    } else {
      expect((await runNativeMigration(f.input)).phase).toBe('retired')
      expect(await f.store.readSettings()).toEqual(settings)
    }
  }
})

test('v5 verified and activation-installed resumes reject changed settings before any write', async () => {
  for (const point of [
    'after-write:journal:verified',
    'after-write:journal:activation-installed',
  ]) {
    const f = await emptyFixture()
    await publishNativeEmptyInit(f.input)
    await stopAt(f.input, point)
    await f.store.updateSettings(() => ({ costZeroing: { enabled: true } }))
    const before = await fileBytes(f)
    let writes = 0
    await expectRefusal(
      runNativeMigration(f.input, {
        onStep: async () => {
          writes++
        },
      }),
      NativeMigrationError,
      'settings-changed',
    )
    expect(writes).toBe(0)
    expect(await fileBytes(f)).toEqual(before)
  }
})

test('v5 routing resumes after preparation and rename, including native pins without a legacy routing source', async () => {
  for (const point of ['after-write:proof', 'after:routing'])
    for (const legacy of [false, true]) {
      const f = await emptyFixture()
      await publishNativeEmptyInit(f.input)
      const pin = {
        accountId: 'native-route',
        family: 'general',
        assignedAt: 1,
        lastSeenAt: 2,
        initialInputBytes: 3,
        quotaCheckedAt: 0,
      }
      await writeFile(
        f.input.routingDestinationPath,
        JSON.stringify({
          version: 1,
          updatedAt: 20,
          assignments: { A: pin },
          vaultLegacySeed: 'complete',
        }),
        { mode: 0o600 },
      )
      if (legacy)
        await writeFile(
          f.input.routingSourcePath,
          JSON.stringify({
            version: 1,
            updatedAt: 10,
            assignments: { B: { ...pin, accountId: 'main' } },
          }),
          { mode: 0o600 },
        )
      await stopAt(f.input, point)
      const journal = await runNativeMigration(f.input)
      expect(journal).toMatchObject({
        version: 5,
        kind: 'legacy-import',
        phase: 'retired',
      })
      const routing = JSON.parse(
        await readFile(f.input.routingDestinationPath, 'utf8'),
      )
      expect(routing.assignments.A).toEqual(pin)
      expect(routing.vaultLegacySeed).toBe('complete')
      if (legacy)
        expect(routing.assignments.B).toEqual({
          ...pin,
          accountId: 'primary-route',
        })
      else expect(Object.keys(routing.assignments)).toEqual(['A'])
    }
})

test('crash after the first v5 building write blocks login and empty-init publication until resume', async () => {
  const f = await emptyFixture()
  await publishNativeEmptyInit(f.input)
  await stopAt(f.input, 'after-write:journal:building')
  const before = await fileBytes(f)
  await expectRefusal(
    publishNativeEmptyInit(f.input),
    NativeAuthorityError,
    'journal-conflict',
  )
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { env: {} },
  })
  deferCleanup(() => runtime.close())
  await expectRefusal(
    runtime.loginOAuth({
      routeId: 'new',
      credential: {
        access: 'synthetic-access',
        refresh: 'synthetic-refresh',
        expires: 2000,
      },
      accountIdentity: '00000000-0000-0000-0000-000000000001',
    }),
    NativeAuthorityError,
    'migration-incomplete',
  )
  expect(await fileBytes(f)).toEqual(before)
  expect((await runNativeMigration(f.input)).phase).toBe('retired')
})

test('pool populated predicate reads account maps and runtime, never routing or preferences', async () => {
  const f = await emptyFixture()
  expect(await nativePoolHoldsAccountData(f)).toBe(false)
  await f.store.updateSettings(() => ({
    routingMode: 'sticky',
    costZeroing: { enabled: true },
  }))
  await writeFile(
    f.input.routingDestinationPath,
    '{malformed routing is not read',
  )
  await writeFile(f.input.routingSourcePath, '{legacy routing is not read')
  expect(await nativePoolHoldsAccountData(f)).toBe(false)
  await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (state) => ({
    ...state,
    accounts: {
      orphan: {
        binding: {
          kind: 'local',
          storageId: f.paths.storageId,
          rowId: 'orphan',
          credentialEpoch: 1,
        },
        lastUsed: 1,
      },
    },
  }))
  expect(await f.store.read()).toMatchObject({ rows: [] })
  expect(await nativePoolHoldsAccountData(f)).toBe(true)
  await rm(f.paths.runtime)
  await writeFile(
    f.paths.state,
    JSON.stringify({ version: 1, accounts: { orphan: { refresh: 'orphan' } } }),
    { mode: 0o600 },
  )
  expect(await nativePoolHoldsAccountData(f)).toBe(true)
  await rm(f.paths.state)
  const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
  config.commonAuthPool = {
    schemaVersion: 1,
    rows: { orphan: { quota: { anthropic: { scoped: [] } } } },
  }
  await writeFile(f.paths.config, JSON.stringify(config))
  expect(await nativePoolHoldsAccountData(f)).toBe(true)
  for (const path of [f.paths.config, f.paths.state, f.paths.runtime]) {
    await writeFile(path, '{invalid', { mode: 0o600 })
    await expect(nativePoolHoldsAccountData(f)).rejects.toThrow()
    await rm(path)
  }
})

test('snapshot predicate accepts a new local OAuth login and rejects every non-servable row', async () => {
  const f = await emptyFixture()
  await publishNativeEmptyInit(f.input)
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    local: {
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid:
          '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid,
      }),
    },
    vault: { env: {} },
  })
  deferCleanup(() => runtime.close())
  await runtime.loginOAuth({
    routeId: 'native',
    credential: {
      access: 'sk-ant-oat01-synthetic',
      refresh: 'synthetic-refresh',
      expires: Date.now() + 3_600_000,
    },
    accountIdentity: '00000000-0000-0000-0000-000000000001',
  })
  const snapshot = await runtime.read()
  expect(snapshotHasServableLocalOAuth(snapshot)).toBe(true)
  const row = snapshot.accounts[0]
  if (!row) throw new Error('expected local row')
  for (const patch of [
    { type: 'api' },
    { enabled: false },
    { state: 'unsupported-access' },
    { source: 'vault', state: 'active' },
  ] satisfies Partial<NativeAccountView>[]) {
    expect(
      snapshotHasServableLocalOAuth({ accounts: [{ ...row, ...patch }] }),
    ).toBe(false)
  }
  expect(snapshotHasServableLocalOAuth({ accounts: [] })).toBe(false)
})

test('completed v4 and v5 journals handle every OpenCode slot without reimport', async () => {
  for (const version of [4, 5])
    for (const phase of ['committed', 'retired'])
      for (const slot of [
        undefined,
        { type: 'api', key: 'synthetic-api' },
        custodyTombstoneOAuth('anthropic'),
        oauth,
      ]) {
        const f = version === 5 ? await emptyFixture() : await fixture()
        if (version === 5) await publishNativeEmptyInit(f.input)
        await stopAt(f.input, `after-write:journal:${phase}`)
        if (slot === undefined) await rm(f.input.hostAuthPath)
        else
          await writeFile(
            f.input.hostAuthPath,
            JSON.stringify({ anthropic: slot }),
          )
        const before = await fileBytes(f)
        let writes = 0
        if (slot === oauth) {
          await expectRefusal(
            runNativeMigration(f.input, {
              onStep: async () => {
                writes++
              },
            }),
            NativeMigrationError,
            'host-login-present',
          )
          expect(writes).toBe(0)
          expect(await fileBytes(f)).toEqual(before)
        } else {
          expect((await runNativeMigration(f.input)).phase).toBe('retired')
          expect(
            JSON.parse(await readFile(f.input.hostAuthPath, 'utf8')).anthropic,
          ).toEqual(slot ?? custodyTombstoneOAuth('anthropic'))
        }
      }
})

test('committed retirement repairs an absent host slot after legitimate serving writes', async () => {
  const f = await fixture()
  await stopAt(f.input, 'after-write:journal:committed')
  await f.store.rotate('primary-route', {
    ...oauth,
    access: 'synthetic-serving-access',
  })
  const before = await readFile(f.paths.state, 'utf8')
  await rm(f.input.hostAuthPath)
  expect((await runNativeMigration(f.input)).phase).toBe('retired')
  expect(await readFile(f.paths.state, 'utf8')).toBe(before)
  expect(
    JSON.parse(await readFile(f.input.hostAuthPath, 'utf8')).anthropic,
  ).toEqual(custodyTombstoneOAuth('anthropic'))
  await expect(stat(f.paths.legacyState)).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

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

test('committed authority refuses a later host login before retirement or repair', async () => {
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
  // Commit follows placeholder installation, so an occupied OAuth slot is a later user login.
  // Refusing it preserves both the new login and legacy sources awaiting retirement.
  const bytes = await fileBytes({ input, paths })
  await expectRefusal(
    runNativeMigration(input),
    NativeMigrationError,
    'host-login-present',
  )
  expect(await fileBytes({ input, paths })).toEqual(bytes)
  expect(await readFile(paths.state, 'utf8')).toBe(before)
  expect((await readNativeMigrationJournal(paths))?.phase).toBe('committed')
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
  const journal = await readNativeMigrationJournal(paths)
  if (journal?.kind === 'empty-init')
    throw new Error('expected legacy migration')
  expect(journal?.version).toBe(4)
  expect(journal && 'kind' in journal).toBe(false)
  expect(journal?.sources).toEqual({
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
  await expectRefusal(
    runNativeMigration(input),
    NativeMigrationError,
    'host-login-present',
  )
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

test('without a setup hook the original credential and settings projection is unchanged', async () => {
  const f = await fixture()
  const config = JSON.parse(await readFile(f.paths.legacyConfig, 'utf8'))
  const projection = projectNativeMigrationSource({
    host: f.input.host,
    storageId: f.paths.storageId,
    configDigest: null,
    config,
    state: JSON.parse(await readFile(f.paths.legacyState, 'utf8')),
    hostAuth: JSON.parse(await readFile(f.input.hostAuthPath, 'utf8')),
  })
  expect((await runNativeMigration(f.input)).phase).toBe('retired')
  expect(await f.store.readSettings()).toMatchObject({
    status: 'ready',
    settings: projection.settings,
  })
  await f.store.close()
})

async function setupSettingsFixture(userFile: boolean) {
  const f = await fixture()
  const target = join(f.root, 'setup-settings.jsonc')
  const settingsPaths = await resolveSettingsPaths('opencode', {
    home: f.root,
    env: { ANTHROPIC_AUTH_SETTINGS_FILE: target },
  })
  if (userFile) await writeFile(target, '{}')
  const calls: Record<string, unknown>[] = []
  const legacyWrites: Record<string, unknown>[] = []
  const imported: Record<string, unknown>[] = []
  const phases: (string | undefined)[] = []
  f.input.writeSetupSettings = async (settings) => {
    phases.push((await readNativeMigrationJournal(f.paths))?.phase)
    const read = await f.store.readSettings()
    if (read.status !== 'ready') throw new Error('Settings were not ready')
    imported.push(read.settings)
    calls.push(structuredClone(settings))
    return writeNativeSetupSettings({
      host: 'opencode',
      settings,
      source: f.paths.legacyConfig,
      paths: settingsPaths,
      writeLegacySettings: async (moved) => {
        legacyWrites.push(moved)
        // Acquires the same native-store writer locks migration normally holds.
        // Completing here proves the after-commit hook cannot wait on itself.
        await f.store.updateSettings((stored) => ({ ...stored, ...moved }))
      },
    })
  }
  return { ...f, target, settingsPaths, calls, legacyWrites, imported, phases }
}

for (const userFile of [false, true]) {
  test(`after-commit setup settings route once to ${userFile ? 'user file' : 'legacy store'} outside credential writer locks`, async () => {
    const f = await setupSettingsFixture(userFile)
    expect((await runNativeMigration(f.input)).phase).toBe('retired')
    expect(f.phases).toEqual(['committed'])
    // Credential import must not include a moved setting, even transiently.
    expect(f.imported).toEqual([
      {
        mainAccountId: 'primary-route',
        formerMainRowId: 'primary-route',
        claustrum: { mode: 'local', disabledAccountIdentities: [] },
      },
    ])
    expect(f.calls).toEqual([
      { fallbackOn: [], costZeroing: { enabled: false } },
    ])
    const stored = await f.store.readSettings()
    if (userFile) {
      expect(JSON.parse(await readFile(f.target, 'utf8'))).toMatchObject({
        fallback_on: [],
        cost_zeroing_enabled: false,
      })
      expect(f.legacyWrites).toEqual([])
      expect(stored).toMatchObject({
        status: 'ready',
        settings: {
          mainAccountId: 'primary-route',
          formerMainRowId: 'primary-route',
        },
      })
      expect(JSON.stringify(stored)).not.toContain('costZeroing')
    } else {
      expect(f.legacyWrites).toEqual(f.calls)
      expect(stored).toMatchObject({ status: 'ready', settings: f.calls[0] })
      await expect(readFile(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const journal = await readFile(f.paths.journal, 'utf8')
    expect(journal).not.toContain('costZeroing')
    expect(journal).not.toContain('fallbackOn')
    expect(journal).not.toContain(f.target)
    await f.store.close()
  })
}

test('setup resume after credential commit re-decides authority when the marker appeared between runs', async () => {
  const f = await setupSettingsFixture(false)
  await stopAt(f.input, 'after-write:journal:committed')
  expect(f.calls).toEqual([])
  expect((await readNativeMigrationJournal(f.paths))?.phase).toBe('committed')
  await writeFile(f.target, '{}')
  await writeFile(f.settingsPaths.marker, 'peer-move-marker')
  expect((await runNativeMigration(f.input)).phase).toBe('retired')
  expect(f.legacyWrites).toEqual([])
  expect(JSON.parse(await readFile(f.target, 'utf8'))).toMatchObject({
    cost_zeroing_enabled: false,
  })
  await f.store.close()
})

test('a crash after setup settings but before retire resumes fill-only without writing them twice', async () => {
  const f = await setupSettingsFixture(true)
  await stopAt(f.input, 'after:setup-settings')
  const bytes = await readFile(f.target, 'utf8')
  const before = await stat(f.target, { bigint: true })
  expect((await readNativeMigrationJournal(f.paths))?.phase).toBe('committed')
  await expect(readFile(f.paths.legacyConfig)).resolves.toBeDefined()
  expect((await runNativeMigration(f.input)).phase).toBe('retired')
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]).toEqual(f.calls[0])
  expect(await readFile(f.target, 'utf8')).toBe(bytes)
  expect((await stat(f.target, { bigint: true })).mtimeNs).toBe(before.mtimeNs)
  expect(f.legacyWrites).toEqual([])
  await f.store.close()
})

for (const outcome of ['refused', 'failed', 'thrown'] as const) {
  test(`a ${outcome} after-commit settings hook preserves committed credentials and the source for retry`, async () => {
    const f = await setupSettingsFixture(true)
    const working = f.input.writeSetupSettings
    f.input.writeSetupSettings = async () => {
      if (outcome === 'thrown') throw new Error('private details')
      return { outcome, reason: 'fixed settings refusal' }
    }
    await expect(runNativeMigration(f.input)).rejects.toMatchObject({
      code: 'setup-settings-write-failed',
      message:
        'Credential transfer is committed, but setup settings were not saved. Run setup again to retry before retiring the legacy source.',
    })
    expect((await readNativeMigrationJournal(f.paths))?.phase).toBe('committed')
    await expect(readFile(f.paths.legacyConfig)).resolves.toBeDefined()
    expect(JSON.parse(await readFile(f.target, 'utf8'))).toEqual({})
    expect((await f.store.read()).status).toBe('ready')
    f.input.writeSetupSettings = working
    expect((await runNativeMigration(f.input)).phase).toBe('retired')
    await expect(readFile(f.paths.legacyConfig)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(f.legacyWrites).toEqual([])
    await f.store.close()
  })
}
