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
import { fileURLToPath } from 'node:url'
import {
  mutateVaultRoster,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import { lockPathFor, withLock } from '@cortexkit/common-auth/fs'

import { custodyTombstoneOAuth } from '../claustrum.ts'
import type { NativeCustodyInventory } from '../native-custody.ts'
import {
  type NativeCustodyActivationHooks,
  type NativeCustodyActivationOptions,
  runNativeCustodyActivation,
} from '../native-custody-activation.ts'
import {
  type NativeMigrationOptions,
  runNativeMigration,
} from '../native-migration.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { readNativeRuntime, updateNativeRuntime } from '../native-runtime.ts'
import {
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
} from '../native-vault-runtime.ts'
import {
  nativeMigrationAuthorityPhase,
  readNativeMigrationJournal,
  requireNativePoolAuthority,
} from '../pool-authority.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()

const MAIN_IDENTITY = 'account-main-uuid'
const WORK_IDENTITY = 'account-work-uuid'
const MAIN_TOKEN = {
  type: 'oauth' as const,
  access: 'synthetic-local-access-main',
  refresh: 'synthetic-local-refresh-main',
  expires: 2000,
}
const WORK_TOKEN = {
  type: 'oauth' as const,
  access: 'synthetic-local-access-work',
  refresh: 'synthetic-local-refresh-work',
  expires: 3000,
}
const API_KEY = {
  type: 'api' as const,
  apiKey: 'synthetic-local-api-key',
  baseURL: 'https://synthetic.invalid',
  authHeader: 'x-api-key' as const,
}
const OTHER_PROVIDER = { type: 'api', key: 'synthetic-unrelated-provider' }
const ROUTING_BYTES = `${JSON.stringify(
  { version: 1, updatedAt: 10, assignments: {} },
  null,
  2,
)}\n`
const SECRETS = [
  MAIN_TOKEN.access,
  MAIN_TOKEN.refresh,
  WORK_TOKEN.access,
  WORK_TOKEN.refresh,
  API_KEY.apiKey,
]

function inventory(
  credentials: NativeCustodyInventory['credentials'] = [
    {
      credentialId: 'oauth:anthropic',
      credentialType: 'oauth',
      accountIdentity: MAIN_IDENTITY,
      state: 'active',
    },
    {
      credentialId: 'oauth:anthropic:work',
      credentialType: 'oauth',
      accountIdentity: WORK_IDENTITY,
      state: 'active',
    },
  ],
): NativeCustodyInventory {
  return { view: 'synthetic-view-1', skipped: [], credentials }
}

interface Fixture {
  root: string
  paths: NativePoolPaths
  migration: NativeMigrationOptions
  options: NativeCustodyActivationOptions
  store: ReturnType<typeof createNativePoolStore>
  main: string
  inventory: { value: NativeCustodyInventory }
}

/**
 * Run the real offline migration on an empty install (no legacy files), then
 * give the retired local pool synthetic accounts through the public store, as
 * a local login would. Nothing here touches a live host, daemon or vault.
 */
async function fixture(
  input: {
    host?: 'opencode' | 'pi'
    accounts?: boolean
    requestVaultActivation?: boolean
    removePiAnthropicAuth?: boolean
  } = {},
): Promise<Fixture> {
  const host = input.host ?? 'opencode'
  const created = await mkdtemp(join(tmpdir(), 'native-custody-activation-'))
  deferCleanup(() => rm(created, { recursive: true, force: true }))
  const root = await realpath(created)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const hostAuthPath = join(root, 'host-auth.json')
  await writeFile(hostAuthPath, JSON.stringify({ other: OTHER_PROVIDER }), {
    mode: 0o600,
  })
  const migration: NativeMigrationOptions = {
    paths,
    host,
    hostAuthPath,
    routingSourcePath: join(root, 'legacy-routing.json'),
    routingDestinationPath: join(root, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: true,
    ...(input.requestVaultActivation ? { requestVaultActivation: true } : {}),
  }
  expect((await runNativeMigration(migration)).phase).toBe('retired')
  await writeFile(migration.routingDestinationPath, ROUTING_BYTES, {
    mode: 0o600,
  })
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  const settings = await store.readSettings()
  if (settings.status !== 'ready') throw new Error('fixture settings')
  const main = settings.settings.mainAccountId as string
  if (input.accounts !== false) {
    await store.add({
      id: main,
      credential: MAIN_TOKEN,
      identity: MAIN_IDENTITY,
    })
    await store.add({
      id: 'work-route',
      credential: WORK_TOKEN,
      identity: WORK_IDENTITY,
      label: 'Work',
    })
    await store.add({ id: 'api-route', credential: API_KEY, label: 'API' })
    await store.updateSettings((current) => {
      current.routing = { mode: 'sticky' }
    })
    const rows = await store.read()
    if (rows.status !== 'ready') throw new Error('fixture rows')
    const epoch = (id: string) =>
      rows.rows.find((row) => row.id === id)?.credentialEpoch ?? 0
    await updateNativeRuntime(paths.runtime, paths.storageId, (current) => {
      current.accounts[main] = {
        binding: {
          kind: 'local',
          storageId: paths.storageId,
          rowId: main,
          credentialEpoch: epoch(main),
          identity: MAIN_IDENTITY,
        },
        lastUsed: 111,
        lastRefreshedAt: 5,
      }
      // Metadata bound to a different account UUID than the row's must be
      // dropped, not moved to the vault route for this row's account.
      current.accounts['work-route'] = {
        binding: {
          kind: 'local',
          storageId: paths.storageId,
          rowId: 'work-route',
          credentialEpoch: epoch('work-route'),
          identity: 'some-other-account-uuid',
        },
        lastUsed: 222,
      }
      current.accounts['api-route'] = {
        binding: {
          kind: 'local',
          storageId: paths.storageId,
          rowId: 'api-route',
          credentialEpoch: epoch('api-route'),
        },
        lastUsed: 333,
      }
      return current
    })
  }
  const vault = { value: inventory() }
  return {
    root,
    paths,
    migration,
    store,
    main,
    inventory: vault,
    options: {
      paths,
      host,
      env: {},
      processFence: async () => {},
      removePiAnthropicAuth: input.removePiAnthropicAuth ?? false,
      discover: async () => vault.value,
    },
  }
}

async function files(f: Fixture): Promise<Record<string, string | null>> {
  const read = async (path: string) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return null
      throw error
    }
  }
  return {
    config: await read(f.paths.config),
    state: await read(f.paths.state),
    runtime: await read(f.paths.runtime),
    roster: await read(f.paths.roster),
    journal: await read(f.paths.journal),
    host: await read(f.migration.hostAuthPath),
    routing: await read(f.migration.routingDestinationPath),
  }
}

async function interrupted(
  f: Fixture,
  point: string,
  extra: NativeCustodyActivationHooks = {},
): Promise<void> {
  await expect(
    runNativeCustodyActivation(f.options, {
      ...extra,
      onStep: async (step) => {
        if (step === point) throw new Error('synthetic interruption')
      },
    }),
  ).rejects.toMatchObject({ code: 'invalid-state' })
}

async function expectPending(paths: NativePoolPaths): Promise<void> {
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
}

/** The committed vault state every successful or resumed activation reaches. */
async function expectVault(f: Fixture): Promise<void> {
  await requireNativePoolAuthority(f.paths)
  const journal = await readNativeMigrationJournal(f.paths)
  expect(journal?.activation).toMatchObject({ phase: 'committed' })
  expect(nativeMigrationAuthorityPhase(journal)).toBe('retired')
  const rows = await f.store.read()
  expect(rows).toMatchObject({ status: 'ready' })
  if (rows.status !== 'ready') return
  expect(rows.rows.map((row) => row.id)).toEqual(['api-route'])
  expect(rows.rows[0]?.credential).toMatchObject(API_KEY)
  const settings = await f.store.readSettings()
  expect(settings).toMatchObject({
    settings: {
      mainAccountId: f.main,
      routing: { mode: 'sticky' },
      claustrum: {
        mode: 'claustrum',
        primaryAccount: {
          credentialId: 'oauth:anthropic',
          accountId: MAIN_IDENTITY,
        },
        disabledAccountIdentities: [],
      },
    },
  })
  const roster = await readVaultRoster(f.paths.roster)
  expect(roster?.rows).toEqual([
    {
      routeId: f.main,
      credentialId: 'oauth:anthropic',
      credentialType: 'oauth',
      accountIdentity: MAIN_IDENTITY,
      state: 'active',
      label: f.main,
      enabled: true,
      addedAt: 0,
    },
    {
      routeId: 'work-route',
      credentialId: 'oauth:anthropic:work',
      credentialType: 'oauth',
      accountIdentity: WORK_IDENTITY,
      state: 'active',
      label: 'Work',
      enabled: true,
      addedAt: expect.any(Number),
    },
  ])
  const runtime = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  if (runtime.status !== 'ready') throw new Error('runtime missing')
  expect(runtime.state.accounts[f.main]).toEqual({
    binding: {
      kind: 'custody',
      storageId: f.paths.storageId,
      routeId: f.main,
      credentialId: 'oauth:anthropic',
      accountIdentity: MAIN_IDENTITY,
      recordVersion: 0,
    },
    lastUsed: 111,
  })
  expect(runtime.state.accounts['work-route']).toEqual({
    binding: {
      kind: 'custody',
      storageId: f.paths.storageId,
      routeId: 'work-route',
      credentialId: 'oauth:anthropic:work',
      accountIdentity: WORK_IDENTITY,
      recordVersion: 0,
    },
  })
  expect(runtime.state.accounts['api-route']).toMatchObject({ lastUsed: 333 })
  const host = JSON.parse(await readFile(f.migration.hostAuthPath, 'utf8'))
  expect(host.other).toEqual(OTHER_PROVIDER)
  if (f.options.host === 'opencode')
    expect(host.anthropic).toEqual(custodyTombstoneOAuth('anthropic'))
  else expect(host.anthropic).toBeUndefined()
  expect(await readFile(f.migration.routingDestinationPath, 'utf8')).toBe(
    ROUTING_BYTES,
  )
  const journalText = await readFile(f.paths.journal, 'utf8')
  for (const secret of SECRETS) expect(journalText).not.toContain(secret)
}

test('a retired local pool switches to vault custody with one credential authority', async () => {
  const f = await fixture()
  await requireNativePoolAuthority(f.paths)
  const result = await runNativeCustodyActivation(f.options)
  expect(result.status).toBe('committed')
  await expectVault(f)
  // A rerun of a committed activation reads and writes nothing it owns.
  const before = await files(f)
  expect((await runNativeCustodyActivation(f.options)).status).toBe('committed')
  expect(await files(f)).toEqual(before)
})

test('a fresh install with a vault request stays unauthorized until activation commits', async () => {
  const f = await fixture({ accounts: false, requestVaultActivation: true })
  const journal = await readNativeMigrationJournal(f.paths)
  expect(journal).toMatchObject({
    phase: 'retired',
    activation: { kind: 'requested' },
  })
  await expectPending(f.paths)
  // Rerunning the migration neither admits serving nor repairs host auth.
  const before = await files(f)
  await runNativeMigration(f.migration)
  expect(await files(f)).toEqual(before)
  await expectPending(f.paths)
  expect((await runNativeCustodyActivation(f.options)).status).toBe('committed')
  await requireNativePoolAuthority(f.paths)
  expect((await readVaultRoster(f.paths.roster))?.rows).toEqual([
    {
      routeId: f.main,
      credentialId: 'oauth:anthropic',
      credentialType: 'oauth',
      accountIdentity: MAIN_IDENTITY,
      state: 'active',
      label: f.main,
      enabled: true,
      addedAt: 0,
    },
  ])
  expect(await f.store.readSettings()).toMatchObject({
    settings: {
      mainAccountId: f.main,
      claustrum: {
        mode: 'claustrum',
        primaryAccount: {
          credentialId: 'oauth:anthropic',
          accountId: MAIN_IDENTITY,
        },
      },
    },
  })
  expect(
    JSON.parse(await readFile(f.migration.hostAuthPath, 'utf8')).anthropic,
  ).toEqual(custodyTombstoneOAuth('anthropic'))
})

/**
 * The real first migration of a legacy vault-custody config with a vault
 * request, using the real roster and runtime publishers. The pool is left
 * retired with the activation requested and serving refused.
 */
async function legacyVaultFixture() {
  const created = await mkdtemp(join(tmpdir(), 'native-custody-legacy-'))
  deferCleanup(() => rm(created, { recursive: true, force: true }))
  const root = await realpath(created)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({
      mainAccountId: 'primary-route',
      claustrum: {
        mode: 'claustrum',
        primaryAccount: {
          credentialId: 'oauth:anthropic',
          accountId: MAIN_IDENTITY,
        },
      },
      accounts: [
        {
          id: 'vault-work',
          type: 'oauth',
          refresh: '',
          enabled: true,
          label: 'Work',
          claustrumScopedCredentialId: 'oauth:anthropic:work',
          anthropicAccountUuid: WORK_IDENTITY,
        },
        {
          id: 'api-route',
          type: 'api',
          apiKey: API_KEY.apiKey,
          baseURL: API_KEY.baseURL,
        },
      ],
    }),
    { mode: 0o600 },
  )
  const hostAuthPath = join(root, 'host-auth.json')
  const vault = inventory()
  const migration: NativeMigrationOptions = {
    paths,
    host: 'opencode',
    hostAuthPath,
    routingSourcePath: join(root, 'legacy-routing.json'),
    routingDestinationPath: join(root, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
    requestVaultActivation: true,
    custody: {
      discover: async () => vault,
      publishSeed: publishNativeVaultRosterSeed,
      publishRuntimeSeed: publishNativeVaultRuntimeSeed,
    },
  }
  expect((await runNativeMigration(migration)).phase).toBe('retired')
  await expectPending(paths)
  const read = async () =>
    Promise.all(
      [
        paths.config,
        paths.state,
        paths.runtime,
        paths.roster,
        hostAuthPath,
        paths.journal,
      ].map((path) => readFile(path, 'utf8')),
    )
  const options: NativeCustodyActivationOptions = {
    paths,
    host: 'opencode',
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
    discover: async () => vault,
  }
  return { paths, read, options }
}

test('a first migration of legacy vault custody is verified and reused without rewriting it', async () => {
  const { paths, read, options } = await legacyVaultFixture()
  const before = await read()
  expect((await runNativeCustodyActivation(options)).status).toBe('committed')
  await requireNativePoolAuthority(paths)
  // Pool, runtime, roster and host bytes are untouched; only the journal
  // records the committed activation.
  const after = await read()
  expect(after.slice(0, 5)).toEqual(before.slice(0, 5))
  expect(after[5]).not.toBe(before[5])
})

test('a first legacy vault activation refuses a roster changed after the migration proved it', async () => {
  type Edit = (row: { label: string; enabled: boolean }) => void
  const edits: Array<[string, Edit]> = [
    [
      'label',
      (row) => {
        row.label = 'Renamed after migration'
      },
    ],
    [
      'enabled',
      (row) => {
        row.enabled = false
      },
    ],
  ]
  for (const [name, edit] of edits) {
    const { paths, read, options } = await legacyVaultFixture()
    // A public roster edit, as vault discovery or a menu action would make.
    await mutateVaultRoster(paths.roster, (current) => {
      if (!current) throw new Error('roster missing')
      const next = structuredClone(current)
      const row = next.rows.find((item) => item.routeId === 'vault-work')
      if (!row) throw new Error('fallback row missing')
      edit(row)
      return { next, result: undefined }
    })
    const before = await read()
    await expect(
      runNativeCustodyActivation(options),
      name,
    ).rejects.toMatchObject({ code: 'migration-proof-changed' })
    expect(await read(), name).toEqual(before)
    await expectPending(paths)
  }
})

test('a first legacy vault activation refuses a roster changed while vault accounts are listed or the plan is recorded', async () => {
  const cases = [
    ['discover', 'label'],
    ['discover', 'enabled'],
    ['journal-write', 'label'],
  ] as const
  for (const [when, field] of cases) {
    const name = `${when} ${field}`
    const { paths, read, options } = await legacyVaultFixture()
    let edited: string[] | undefined
    const edit = async () => {
      await mutateVaultRoster(paths.roster, (current) => {
        if (!current) throw new Error('roster missing')
        const next = structuredClone(current)
        const row = next.rows.find((item) => item.routeId === 'vault-work')
        if (!row) throw new Error('fallback row missing')
        if (field === 'label') row.label = 'Renamed during activation'
        else row.enabled = false
        return { next, result: undefined }
      })
      edited = await read()
    }
    const result = await runNativeCustodyActivation(
      {
        ...options,
        // The vault listing itself is unchanged; only the roster file is
        // edited while it runs, after the activation has started.
        discover: async () => {
          if (when === 'discover') await edit()
          return options.discover()
        },
      },
      {
        // Inside the journal write that would record the plan, before its
        // rename: the last check before the plan becomes durable.
        onStep: async (step) => {
          if (
            when === 'journal-write' &&
            step === 'before-write:journal:prepared'
          )
            await edit()
        },
      },
    ).then(
      (value) => value,
      (error: unknown) => error,
    )
    if (!edited) throw new Error(`${name}: edit point was not reached`)
    // Nothing after the external edit: no journal record, pool, runtime,
    // roster or host write by the activation.
    expect(await read(), name).toEqual(edited)
    expect(result, name).toMatchObject({ code: 'migration-proof-changed' })
    await expectPending(paths)
  }
})

test('the designated primary is required and an already-bound main never adopts another account', async () => {
  const cases: Array<[string, NativeCustodyInventory['credentials']]> = [
    [
      'primary-missing',
      [
        {
          credentialId: 'oauth:anthropic:work',
          credentialType: 'oauth',
          accountIdentity: WORK_IDENTITY,
          state: 'active',
        },
      ],
    ],
    [
      'primary-mismatch',
      [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: 'a-different-account-uuid',
          state: 'active',
        },
        {
          credentialId: 'oauth:anthropic:work',
          credentialType: 'oauth',
          accountIdentity: WORK_IDENTITY,
          state: 'active',
        },
      ],
    ],
    [
      'unenrolled-local-row',
      [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: MAIN_IDENTITY,
          state: 'active',
        },
      ],
    ],
    [
      'vault-ambiguous',
      [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: MAIN_IDENTITY,
          state: 'active',
        },
        {
          credentialId: 'oauth:anthropic:work',
          credentialType: 'oauth',
          accountIdentity: WORK_IDENTITY,
          state: 'active',
        },
        {
          credentialId: 'oauth:anthropic:work-2',
          credentialType: 'oauth',
          accountIdentity: WORK_IDENTITY,
          state: 'active',
        },
      ],
    ],
  ]
  for (const [code, credentials] of cases) {
    const f = await fixture()
    f.inventory.value = inventory(credentials)
    const before = await files(f)
    await expect(runNativeCustodyActivation(f.options)).rejects.toMatchObject({
      code,
    })
    expect(await files(f)).toEqual(before)
    await requireNativePoolAuthority(f.paths)
  }
})

test('environment, process and consent fences refuse before any write', async () => {
  const f = await fixture()
  const before = await files(f)
  await expect(
    runNativeCustodyActivation({
      ...f.options,
      env: { OPENCODE_AUTH_CONTENT: '{}' },
    }),
  ).rejects.toMatchObject({ code: 'auth-content-refused' })
  await expect(
    runNativeCustodyActivation({
      ...f.options,
      processFence: async () => {
        throw new Error('synthetic running host')
      },
    }),
  ).rejects.toMatchObject({ code: 'process-fence-refused' })
  expect(await files(f)).toEqual(before)

  // The fence runs immediately before each write: a host that starts later
  // stops the activation at that write, and a rerun resumes it.
  let calls = 0
  const g = await fixture()
  await runNativeCustodyActivation({
    ...g.options,
    processFence: async () => {
      calls++
    },
  })
  const total = calls
  expect(total).toBeGreaterThan(10)
  for (let failAt = 2; failAt <= total; failAt += Math.ceil(total / 6)) {
    const h = await fixture()
    calls = 0
    await expect(
      runNativeCustodyActivation({
        ...h.options,
        processFence: async () => {
          calls++
          if (calls === failAt) throw new Error('synthetic host started')
        },
      }),
    ).rejects.toMatchObject({ code: 'process-fence-refused' })
    const journal = await readNativeMigrationJournal(h.paths)
    if (journal?.activation) await expectPending(h.paths)
    expect((await runNativeCustodyActivation(h.options)).status).toBe(
      'committed',
    )
    await expectVault(h)
  }
})

const STEPS = [
  'before:prepare',
  'before-write:journal:prepared',
  'after-write:journal:prepared',
  'after:prepare',
  'before:roster',
  'after:roster',
  'before:runtime',
  'after:runtime',
  'before:remove:0',
  'after:remove:0',
  'before:remove:1',
  'after:remove:1',
  'before-write:journal:published',
  'after-write:journal:published',
  'before:mode-rename',
  'after:mode-rename',
  'before:authority-rename',
  'before-write:journal:committed',
]

test('an interruption at every boundary leaves serving refused and resumes to the same vault state', async () => {
  for (const point of STEPS) {
    const f = await fixture()
    await interrupted(f, point)
    const journal = await readNativeMigrationJournal(f.paths)
    // Before the prepared journal write nothing is recorded or changed.
    if (journal?.activation === null) await requireNativePoolAuthority(f.paths)
    else await expectPending(f.paths)
    expect((await runNativeCustodyActivation(f.options)).status, point).toBe(
      'committed',
    )
    await expectVault(f)
  }
})

test('an interrupted removal between its config and state writes completes through the attributed fence', async () => {
  const f = await fixture()
  await interrupted(f, 'never', {
    store: {
      onStep: async (step, info) => {
        if (step === 'after-config-write' && info.operation === 'remove')
          throw new Error('synthetic interruption')
      },
    },
  })
  await expectPending(f.paths)
  const rows = await f.store.read()
  expect(rows.status === 'ready' && rows.rows.map((row) => row.id)).toEqual([
    'work-route',
    'api-route',
  ])
  expect((await runNativeCustodyActivation(f.options)).status).toBe('committed')
  await expectVault(f)
})

/** Add a pool row from a separate Bun process through the public store. */
async function addInAnotherProcess(
  paths: NativePoolPaths,
  row: { id: string; credential: unknown; identity: string },
): Promise<void> {
  const module = (name: string) =>
    JSON.stringify(new URL(name, import.meta.url).href)
  const script = `
    const { createNativePoolStore } = await import(${module('../pool-store.ts')})
    const { nativeQuotaCodec } = await import(${module('../native-quota-codec.ts')})
    await createNativePoolStore({
      paths: ${JSON.stringify(paths)},
      quota: nativeQuotaCodec,
    }).add(${JSON.stringify(row)})
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exited = child.exited
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  deferCleanup(async () => {
    child.kill()
    await Promise.allSettled([exited, stdout, stderr])
  })
  const code = await exited
  const [, errors] = await Promise.all([stdout, stderr])
  expect(code, errors).toBe(0)
}

test('resume refuses a removed id re-added at a new epoch, a changed token and an added row', async () => {
  const mutations: Array<[string, (f: Fixture) => Promise<void>]> = [
    [
      'after:remove:0',
      async (f) => {
        const removed = [f.main, 'work-route'].sort()[0] as string
        // A store refuses to reuse an id it removed itself in this process,
        // so another process re-adds it, as a later local login would.
        await addInAnotherProcess(f.paths, {
          id: removed,
          credential: removed === f.main ? MAIN_TOKEN : WORK_TOKEN,
          identity: removed === f.main ? MAIN_IDENTITY : WORK_IDENTITY,
        })
      },
    ],
    [
      'after:roster',
      async (f) => {
        await f.store.rotate('work-route', {
          ...WORK_TOKEN,
          access: 'synthetic-rotated-access',
        })
      },
    ],
    [
      'after:prepare',
      async (f) => {
        await f.store.add({
          id: 'added-api',
          credential: { ...API_KEY, apiKey: 'synthetic-added-key' },
        })
      },
    ],
  ]
  for (const [point, mutate] of mutations) {
    const f = await fixture()
    await interrupted(f, point)
    await mutate(f)
    const before = await files(f)
    await expect(runNativeCustodyActivation(f.options)).rejects.toMatchObject({
      code: 'credential-changed',
    })
    expect(await files(f)).toEqual(before)
    await expectPending(f.paths)
  }
})

async function changeRoutingPreference(f: Fixture): Promise<void> {
  // A separate store instance stands in for a user editing preferences.
  await createNativePoolStore({
    paths: f.paths,
    quota: nativeQuotaCodec,
  }).updateSettings((settings) => {
    settings.routing = { mode: 'round-robin' }
  })
}

test('resume refuses changed preferences, runtime metadata and roster before any forward write', async () => {
  const mutations: Array<[string, string, (f: Fixture) => Promise<void>]> = [
    ['after:prepare', 'settings-conflict', changeRoutingPreference],
    ['after:roster', 'settings-conflict', changeRoutingPreference],
    ['after:runtime', 'settings-conflict', changeRoutingPreference],
    ['after:remove:0', 'settings-conflict', changeRoutingPreference],
    [
      'after:prepare',
      'runtime-conflict',
      async (f) => {
        await updateNativeRuntime(
          f.paths.runtime,
          f.paths.storageId,
          (state) => {
            const entry = state.accounts['api-route']
            if (entry) entry.lastUsed = 999
            return state
          },
        )
      },
    ],
    [
      'after:roster',
      'roster-conflict',
      async (f) => {
        const roster = JSON.parse(await readFile(f.paths.roster, 'utf8'))
        roster.rows[1].label = 'Renamed'
        await writeFile(f.paths.roster, JSON.stringify(roster), { mode: 0o600 })
      },
    ],
  ]
  for (const [point, code, mutate] of mutations) {
    const f = await fixture()
    await interrupted(f, point)
    await mutate(f)
    // Roster, runtime, pool rows and config, host entry and journal bytes.
    const before = await files(f)
    await expect(
      runNativeCustodyActivation(f.options),
      `${point} ${code}`,
    ).rejects.toMatchObject({ code })
    expect(await files(f), `${point} ${code}`).toEqual(before)
    await expectPending(f.paths)
  }
})

test('a preference changed during a run refuses before the next roster, runtime or removal write', async () => {
  for (const point of ['before:roster', 'before:runtime', 'before:remove:0']) {
    const f = await fixture()
    let before: Record<string, string | null> | undefined
    await expect(
      runNativeCustodyActivation(f.options, {
        onStep: async (step) => {
          if (step !== point) return
          await changeRoutingPreference(f)
          before = await files(f)
        },
      }),
      point,
    ).rejects.toMatchObject({ code: 'settings-conflict' })
    if (!before) throw new Error(`step ${point} was not reached`)
    expect(await files(f), point).toEqual(before)
    await expectPending(f.paths)
  }
})

test('Pi stored OAuth is removed only with consent, a Pi API key always refuses, and a changed token never resumes', async () => {
  const login = {
    type: 'oauth',
    access: 'synthetic-pi-access',
    refresh: 'synthetic-pi-refresh',
    expires: 5000,
  }
  const withEntry = async (
    entry: unknown,
    removePiAnthropicAuth: boolean,
  ): Promise<Fixture> => {
    const f = await fixture({ host: 'pi', removePiAnthropicAuth })
    await writeFile(
      f.migration.hostAuthPath,
      JSON.stringify({ anthropic: entry, other: OTHER_PROVIDER }),
      { mode: 0o600 },
    )
    return f
  }
  const refused = await withEntry(login, false)
  let before = await files(refused)
  await expect(
    runNativeCustodyActivation(refused.options),
  ).rejects.toMatchObject({ code: 'consent-required' })
  expect(await files(refused)).toEqual(before)

  const key = await withEntry(
    { type: 'api_key', key: 'synthetic-pi-api-key' },
    true,
  )
  before = await files(key)
  await expect(runNativeCustodyActivation(key.options)).rejects.toMatchObject({
    code: 'primary-conflict',
  })
  expect(await files(key)).toEqual(before)

  const consented = await withEntry(login, true)
  expect((await runNativeCustodyActivation(consented.options)).status).toBe(
    'committed',
  )
  await expectVault(consented)

  const changed = await withEntry(login, true)
  await interrupted(changed, 'after:prepare')
  await writeFile(
    changed.migration.hostAuthPath,
    JSON.stringify({
      anthropic: { ...login, access: 'synthetic-pi-relogin' },
      other: OTHER_PROVIDER,
    }),
    { mode: 0o600 },
  )
  before = await files(changed)
  await expect(
    runNativeCustodyActivation(changed.options),
  ).rejects.toMatchObject({ code: 'host-auth-changed' })
  expect(await files(changed)).toEqual(before)
  await expectPending(changed.paths)
})

test('an OpenCode stock API key stays under host control and a real host login refuses', async () => {
  const api = await fixture()
  const stock = { type: 'api', key: 'synthetic-opencode-api-key' }
  await writeFile(
    api.migration.hostAuthPath,
    JSON.stringify({ anthropic: stock, other: OTHER_PROVIDER }),
    { mode: 0o600 },
  )
  expect((await runNativeCustodyActivation(api.options)).status).toBe(
    'committed',
  )
  expect(
    JSON.parse(await readFile(api.migration.hostAuthPath, 'utf8')).anthropic,
  ).toEqual(stock)

  const login = await fixture()
  await writeFile(
    login.migration.hostAuthPath,
    JSON.stringify({ anthropic: { ...MAIN_TOKEN }, other: OTHER_PROVIDER }),
    { mode: 0o600 },
  )
  const before = await files(login)
  await expect(runNativeCustodyActivation(login.options)).rejects.toMatchObject(
    { code: 'host-auth-changed' },
  )
  expect(await files(login)).toEqual(before)
})

/**
 * Take a lease away from its holder the way an expired lease is lost: remove
 * its lock file and let a public contender acquire it. The contender holds it
 * until released, so the original holder can only find out by asserting.
 */
async function steal(target: string, name: string, ttlMs = 30_000) {
  await rm(lockPathFor(target, name), { force: true })
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquired: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const held = withLock(
    target,
    { name, ttlMs, timeoutMs: 1_000, renew: true },
    async () => {
      acquired()
      await released
    },
  )
  await ready
  return async () => {
    release()
    await held
  }
}

/**
 * Run an activation that hands a lease to a contender at `point`. The
 * contender is released as soon as the run settles, or earlier at `releaseAt`
 * if the run gets that far, and always in `finally`, so a run that wrongly
 * keeps going reaches its postcondition assertions instead of waiting on the
 * contender until the test deadline.
 */
async function runWithStolenLease(
  f: Fixture,
  point: string,
  releaseAt: string,
  take: () => Promise<() => Promise<void>>,
): Promise<unknown> {
  let free: (() => Promise<void>) | undefined
  const release = async () => {
    const pending = free
    free = undefined
    await pending?.()
  }
  try {
    return await runNativeCustodyActivation(f.options, {
      onStep: async (step) => {
        if (step === point) free = await take()
        else if (step === releaseAt) await release()
      },
    }).then(
      (result) => result,
      (error: unknown) => error,
    )
  } finally {
    await release()
  }
}

for (const lease of ['runtime', 'routing'] as const) {
  test(`losing the ${lease} lease immediately before the mode rename refuses with settings unchanged`, async () => {
    const f = await fixture()
    const outcome = await runWithStolenLease(
      f,
      'before:mode-rename',
      'after:mode-rename',
      () =>
        lease === 'runtime'
          ? steal(f.paths.runtime, 'native-runtime')
          : steal(f.migration.routingDestinationPath, 'write'),
    )
    expect(await f.store.readSettings()).toMatchObject({
      settings: { claustrum: { mode: 'local' } },
    })
    expect(await readNativeMigrationJournal(f.paths)).toMatchObject({
      activation: { phase: 'published' },
    })
    expect(outcome).toMatchObject({ code: 'ownership-lost' })
    await expectPending(f.paths)
    expect((await runNativeCustodyActivation(f.options)).status).toBe(
      'committed',
    )
    await expectVault(f)
  })
}

test('loss or drift between the mode rename and the authority rename leaves the activation published', async () => {
  const lossCases: Array<
    [string, (f: Fixture) => Promise<() => Promise<void>>]
  > = [
    ['runtime', (f) => steal(f.paths.runtime, 'native-runtime')],
    ['routing', (f) => steal(f.migration.routingDestinationPath, 'write')],
    ['pool-config', (f) => steal(f.paths.config, 'pool-config')],
  ]
  for (const [name, take] of lossCases) {
    const f = await fixture()
    const outcome = await runWithStolenLease(
      f,
      'before:authority-rename',
      'after-write:journal:committed',
      () => take(f),
    )
    expect(
      (await readNativeMigrationJournal(f.paths))?.activation,
      name,
    ).toMatchObject({ phase: 'published' })
    expect(outcome, name).toMatchObject({ code: 'ownership-lost' })
    await expectPending(f.paths)
    expect((await runNativeCustodyActivation(f.options)).status).toBe(
      'committed',
    )
  }
  const drift = await fixture()
  await expect(
    runNativeCustodyActivation(drift.options, {
      onStep: async (step) => {
        if (step !== 'before:authority-rename') return
        await writeFile(
          drift.migration.hostAuthPath,
          JSON.stringify({ anthropic: MAIN_TOKEN, other: OTHER_PROVIDER }),
          { mode: 0o600 },
        )
      },
    }),
  ).rejects.toMatchObject({ code: 'host-auth-changed' })
  expect(await readNativeMigrationJournal(drift.paths)).toMatchObject({
    activation: { phase: 'published' },
  })
  await expectPending(drift.paths)
})

async function expireAbandonedLocks(root: string): Promise<void> {
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
    const inode = (await stat(path)).ino
    // The child process is dead. Expire only its own lock marker, keeping the
    // owner and inode, so a successor reclaims it without waiting out the TTL.
    await writeFile(path, JSON.stringify({ ...value, expiresAt: 0 }))
    expect((await stat(path)).ino).toBe(inode)
  }
}

const CHILD_POINTS: Array<['step' | 'store', string]> = [
  ['step', 'after-write:journal:prepared'],
  ['step', 'after:runtime'],
  ['store', 'after-config-write:remove'],
  ['step', 'after:remove:1'],
  ['step', 'before:mode-rename'],
  ['store', 'after-config-write:updateSettings'],
  ['step', 'before:authority-rename'],
  ['step', 'before-write:journal:committed'],
]

for (const [kind, point] of CHILD_POINTS) {
  test(`a setup process killed at ${point} leaves serving refused and a successor completes`, async () => {
    const f = await fixture()
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL(
            './native-custody-activation-crash-child.ts',
            import.meta.url,
          ),
        ),
        f.paths.legacyConfig,
        f.paths.legacyState,
        'opencode',
        JSON.stringify(f.inventory.value),
        kind,
        point,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    // Each stream is read exactly once. If the body fails, cleanup cancels
    // the owned child first, then drains its exit status and both streams
    // before the fixture directory is removed.
    const exited = child.exited
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    deferCleanup(async () => {
      child.kill()
      await Promise.allSettled([exited, stdout, stderr])
    })
    const code = await exited
    const [, errors] = await Promise.all([stdout, stderr])
    expect(code, errors).toBe(19)
    await expectPending(f.paths)
    await expireAbandonedLocks(f.root)
    expect((await runNativeCustodyActivation(f.options)).status).toBe(
      'committed',
    )
    await expectVault(f)
  })
}
