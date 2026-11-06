import { afterEach, expect, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mutateVaultRoster,
  projectVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { createNativeVaultRuntime } from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import {
  getStickyRoutingStatePath,
  StickySessionRouter,
} from '../sticky-routing.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const runtimes = new Set<{ close(): void }>()
afterEach(() => {
  for (const runtime of runtimes) runtime.close()
  runtimes.clear()
})
const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
function ownRuntime<T extends { close(): void }>(runtime: T): T {
  runtimes.add(runtime)
  deferCleanup(() => runtime.close())
  return runtime
}
const mainUuid = '11111111-2222-4333-8444-555555555555'
const workUuid = '22222222-2222-4333-8444-555555555555'
const absentUuid = '33333333-2222-4333-8444-555555555555'
const model = 'claude-sonnet-5-5'
const key = (session: string) =>
  createHash('sha256').update(session).digest('hex')
const preferences = {
  routing: { mode: 'sticky-balanced' },
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: {
    enabled: true,
    always: true,
    startHour: 8,
    endHour: 22,
    subagents: false,
  },
  quota: {
    enabled: true,
    checkIntervalMinutes: 7,
    minimumRemaining: { five_hour: 12, seven_day: 13, scoped: 14 },
    failClosedOnUnknownQuota: true,
  },
  killswitch: {
    enabled: true,
    main: { five_hour: 20, seven_day: 25, scoped: 30 },
  },
  fallbackOn: [429, 529],
  claudeFast: { enabled: true },
  prime: { enabled: false },
  logging: { level: 'debug' },
  dump: { enabled: true },
}

async function fixture(verified = true) {
  const root = await mkdtemp(join(tmpdir(), 'vault-legacy-seed-'))
  const routers: StickySessionRouter[] = []
  let accountRuntime: ReturnType<typeof createNativeAccountRuntime> | undefined
  deferCleanup(async () => {
    await accountRuntime?.drainRoutingPublications()
    await Promise.all(routers.map((router) => router.drain()))
    await rm(root, { recursive: true, force: true })
  })
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  const vault = nativeVaultPaths(paths)
  const now = Date.now()
  const config = {
    version: 1,
    ...preferences,
    killswitch: {
      ...preferences.killswitch,
      accounts: { 'old-work': { five_hour: 33, seven_day: 34 } },
    },
    mainAccountId: mainUuid,
    claustrum: {
      mode: 'claustrum',
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: mainUuid,
        state: 'active',
      },
    },
    accounts: [
      {
        id: 'old-work',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        addedAt: now,
        claustrumScopedCredentialId: 'oauth:work',
        anthropicAccountUuid: workUuid,
      },
      {
        id: 'old-missing',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        addedAt: now,
        anthropicAccountUuid: absentUuid,
      },
    ],
    relay: { enabled: true, token: 'synthetic-relay-secret' },
    refresh: { enabled: false },
    apiKey: 'synthetic-key',
  }
  const pin = (accountId: string) => ({
    accountId,
    family: 'general',
    affinityModelId: model,
    assignedAt: now - 10,
    lastSeenAt: now,
    initialInputBytes: 123,
    quotaCheckedAt: 0,
  })
  const legacyRouting = getStickyRoutingStatePath(paths.legacyConfig)
  await writeFile(paths.legacyConfig, JSON.stringify(config, null, 2), {
    mode: 0o600,
  })
  await writeFile(
    legacyRouting,
    JSON.stringify({
      version: 1,
      updatedAt: now,
      assignments: {
        [key('main-session')]: pin('main'),
        [key('work-session')]: pin('old-work'),
        [key('unmatched-session')]: pin('old-missing'),
        [key('unknown-session')]: pin('unknown'),
      },
    }),
    { mode: 0o600 },
  )
  await writeFile(paths.legacyState, '{"token":"synthetic-state-secret"}', {
    mode: 0o600,
  })
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
  }
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const roster = projectVaultRoster(
    undefined,
    {
      view: 'verified',
      credentials: [
        {
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: mainUuid,
          state: 'active',
        },
        {
          credentialId: 'oauth:work',
          credentialType: 'oauth',
          accountIdentity: workUuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now },
  )
  const publishRoster = () =>
    mutateVaultRoster(vault.roster, () => ({ next: roster, result: undefined }))
  if (verified) await publishRoster()
  const mainRoute = roster.rows.find(
    (row) => row.accountIdentity === mainUuid,
  )?.routeId
  const workRoute = roster.rows.find(
    (row) => row.accountIdentity === workUuid,
  )?.routeId
  if (!mainRoute || !workRoute) throw new Error('Fixture roster has no routes')
  const options = { paths, host: 'opencode' as const, vault: { env } }
  const runtime = ownRuntime(createNativeAccountRuntime(options))
  accountRuntime = runtime
  const readAndDrain = async () => {
    const snapshot = await runtime.read()
    await runtime.drainRoutingPublications()
    return snapshot
  }
  const store = createNativePoolStore({ paths: vault, quota: nativeQuotaCodec })
  const router = () => {
    const value = new StickySessionRouter({
      path: vault.routing,
      vaultSeed: {
        legacyConfig: paths.legacyConfig,
        roster: vault.roster,
        mainRouteId: mainRoute,
      },
    })
    routers.push(value)
    return value
  }
  const resolveAndDrain = async (
    session: string,
    routerInstance = router(),
    identities = new Map([
      ['main', mainUuid],
      [workRoute, workUuid],
    ]),
  ) => {
    const resolution = await routerInstance.resolve({
      sessionId: session,
      family: 'general',
      modelId: model,
      candidates: [
        { accountId: workRoute, quota: { kind: 'unknown' }, order: 0 },
      ],
      retainAccountIds: new Set(['main', workRoute]),
      accountIdentities: identities,
      storage: null,
      inputBytes: 1,
    })
    await routerInstance.drain()
    return resolution
  }
  const legacyBefore = await Promise.all(
    [paths.legacyConfig, paths.legacyState, legacyRouting].map((path) =>
      readFile(path),
    ),
  )
  const assertLegacy = async () =>
    expect(
      await Promise.all(
        [paths.legacyConfig, paths.legacyState, legacyRouting].map((path) =>
          readFile(path),
        ),
      ),
    ).toEqual(legacyBefore)
  return {
    paths,
    vault,
    runtime,
    options,
    store,
    roster,
    publishRoster,
    mainRoute,
    workRoute,
    router,
    resolveAndDrain,
    readAndDrain,
    assertLegacy,
    config,
    legacyRouting,
    now,
  }
}

test('first vault snapshot seeds validated preferences and UUID-translated pins without touching legacy bytes', async () => {
  const f = await fixture()
  const snapshot = await f.readAndDrain()
  for (const [section, value] of Object.entries(preferences))
    expect(snapshot.settings[section]).toEqual(value)
  const settings = JSON.parse(await readFile(f.vault.config, 'utf8'))
  for (const [section, value] of Object.entries(preferences))
    expect(settings[section]).toEqual(value)
  expect(settings).not.toHaveProperty('accounts')
  expect(settings).not.toHaveProperty('relay')
  expect(settings).not.toHaveProperty('refresh')
  expect(settings.killswitch).not.toHaveProperty('accounts')
  const routing = JSON.parse(await readFile(f.vault.routing, 'utf8'))
  expect(routing.vaultLegacySeed).toBe('complete')
  expect(Object.keys(routing.assignments).sort()).toEqual(
    [key('main-session'), key('work-session')].sort(),
  )
  expect(routing.assignments[key('main-session')]).toMatchObject({
    accountId: f.mainRoute,
    accountIdentity: mainUuid,
    initialInputBytes: 123,
  })
  expect(routing.assignments[key('work-session')]).toMatchObject({
    accountId: f.workRoute,
    accountIdentity: workUuid,
    assignedAt: f.now - 10,
  })
  expect((await f.resolveAndDrain('work-session'))?.created).toBe(false)
  expect((await f.resolveAndDrain('main-session'))?.accountId).toBe('main')
  for (const path of [f.vault.config, f.vault.routing])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  await f.assertLegacy()
})

test('existing pin-only Mac settings and unmarked live routing remain byte-identical on start', async () => {
  const f = await fixture()
  const settings = {
    mainAccountId: f.mainRoute,
    claustrum: {
      primaryAccount: { credentialId: 'oauth:anthropic', accountId: mainUuid },
    },
  }
  await writeFile(f.vault.config, JSON.stringify(settings), { mode: 0o600 })
  await writeFile(
    f.vault.routing,
    JSON.stringify({ version: 1, updatedAt: f.now, assignments: {} }),
    { mode: 0o600 },
  )
  const before = await Promise.all(
    [f.vault.config, f.vault.routing].map((path) => readFile(path)),
  )
  await f.readAndDrain()
  expect(
    await Promise.all(
      [f.vault.config, f.vault.routing].map((path) => readFile(path)),
    ),
  ).toEqual(before)
  await f.store.updateSettings((s) => ({
    ...s,
    routing: { mode: 'fallback-first' },
    logging: { level: 'error' },
  }))
  expect(await f.store.readSettings()).toMatchObject({
    settings: {
      ...settings,
      routing: { mode: 'fallback-first' },
      logging: { level: 'error' },
    },
  })
  const changedSettings = JSON.parse(await readFile(f.vault.config, 'utf8'))
  expect(changedSettings).toEqual({
    ...settings,
    routing: { mode: 'fallback-first' },
    logging: { level: 'error' },
  })
  await f.resolveAndDrain('live-session')
  const live = await Promise.all(
    [f.vault.config, f.vault.routing].map((path) => readFile(path)),
  )
  const restarted = ownRuntime(createNativeAccountRuntime(f.options))
  await restarted.read()
  expect(
    await Promise.all(
      [f.vault.config, f.vault.routing].map((path) => readFile(path)),
    ),
  ).toEqual(live)
  expect(JSON.parse(live[1]!.toString())).not.toHaveProperty('vaultLegacySeed')
  await f.assertLegacy()
})

test('request during routing deferral routes normally without creating an empty file or marker', async () => {
  const f = await fixture(false)
  expect((await f.readAndDrain()).settings.routing).toEqual(preferences.routing)
  await expect(stat(f.vault.routing)).rejects.toMatchObject({ code: 'ENOENT' })
  const result = await f.resolveAndDrain(
    'no-verified-route',
    f.router(),
    new Map(),
  )
  expect(result).toBeNull()
  await expect(stat(f.vault.routing)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.publishRoster()
  await f.readAndDrain()
  expect(
    JSON.parse(await readFile(f.vault.routing, 'utf8')).vaultLegacySeed,
  ).toBe('complete')
})

test('a live pin during deferral survives the one-time seed and later starts never re-seed', async () => {
  const f = await fixture(false)
  await mutateVaultRoster(f.vault.roster, () => ({
    next: { ...f.roster, complete: false },
    result: undefined,
  }))
  await f.readAndDrain()
  expect((await f.resolveAndDrain('main-session'))?.accountId).toBe(f.workRoute)
  const pending = JSON.parse(await readFile(f.vault.routing, 'utf8'))
  expect(pending.vaultLegacySeed).toBe('pending')
  const livePin = pending.assignments[key('main-session')]
  expect(livePin.accountId).toBe(f.workRoute)
  await f.publishRoster()
  await f.readAndDrain()
  const seeded = JSON.parse(await readFile(f.vault.routing, 'utf8'))
  expect(seeded.vaultLegacySeed).toBe('complete')
  expect(seeded.assignments[key('main-session')]).toEqual(livePin)
  expect(seeded.assignments[key('work-session')].accountId).toBe(f.workRoute)
  await f.store.updateSettings((s) => ({
    ...s,
    routing: { mode: 'fallback-first' },
  }))
  const clearing = f.router()
  await clearing.clear('work-session')
  await clearing.drain()
  const before = await Promise.all(
    [f.vault.config, f.vault.routing].map((path) => readFile(path)),
  )
  const restarted = ownRuntime(createNativeAccountRuntime(f.options))
  await restarted.read()
  expect(
    await Promise.all(
      [f.vault.config, f.vault.routing].map((path) => readFile(path)),
    ),
  ).toEqual(before)
  await f.assertLegacy()
})

test('discovery main-pin first creation includes the seed in its single config write', async () => {
  const f = await fixture(false)
  const runtime = ownRuntime(
    createNativeVaultRuntime({
      paths: f.paths,
      host: 'opencode',
      env: f.options.vault.env,
      discover: async () => ({
        view: 'verified',
        credentials: f.roster.rows.map((row) => ({
          credentialId: row.credentialId,
          credentialType: row.credentialType,
          accountIdentity: row.accountIdentity,
          state: row.state,
        })),
        skipped: [],
      }),
    }),
  )
  const writes: unknown[] = []
  const originalRename = fs.rename
  const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === f.vault.config)
      writes.push(JSON.parse(await readFile(from, 'utf8')))
    return originalRename(from, to)
  })
  deferCleanup(() => rename.mockRestore())
  await runtime.refresh()
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    ...preferences,
    mainAccountId: f.mainRoute,
  })
  await f.assertLegacy()
})

test('invalid settings fields are dropped while valid siblings survive and no credential or runtime metadata is imported', async () => {
  const f = await fixture()
  await writeFile(
    f.paths.legacyConfig,
    JSON.stringify({
      ...f.config,
      routing: { mode: 'invalid' },
      claudeCache: {
        enabled: true,
        mode: 'invalid',
        token: 'synthetic-secret',
      },
      quota: {
        enabled: 'invalid',
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 101, scoped: 10 },
        failClosedOnUnknownQuota: false,
        mainQuotaToken: 'synthetic-secret',
      },
      killswitch: {
        enabled: 'invalid',
        main: { five_hour: 101, scoped: 15 },
        accounts: { 'old-work': { seven_day: 90 } },
      },
      logging: { level: 'invalid' },
      fallbackOn: [429, 'bad', 529],
    }),
    { mode: 0o600 },
  )
  const settings = (await f.readAndDrain()).settings
  expect(settings).not.toHaveProperty('routing')
  expect(settings.claudeCache).toEqual({ enabled: true })
  expect(settings.quota).toEqual({
    checkIntervalMinutes: 5,
    minimumRemaining: { scoped: 10 },
    failClosedOnUnknownQuota: false,
  })
  expect(settings.killswitch).toEqual({ main: { scoped: 15 } })
  expect(settings).not.toHaveProperty('logging')
  expect(settings.fallbackOn).toEqual([429, 529])
  expect(await readFile(f.vault.config, 'utf8')).not.toContain(
    'synthetic-secret',
  )
})

test('missing unreadable or malformed legacy input never refuses vault serving', async () => {
  for (const bad of ['missing', 'directory', 'malformed']) {
    const f = await fixture()
    await rm(f.paths.legacyConfig)
    if (bad === 'directory') await fs.mkdir(f.paths.legacyConfig)
    if (bad === 'malformed')
      await writeFile(f.paths.legacyConfig, '{invalid', { mode: 0o600 })
    expect((await f.readAndDrain()).mode).toBe('claustrum')
    await f.store.updateSettings((s) => ({ ...s, logging: { level: 'error' } }))
    expect((await f.store.readSettings()).status).toBe('ready')
  }
})

test('settings seed interruption before rename leaves no partial file and a retry seeds completely', async () => {
  const f = await fixture()
  const store = createNativePoolStore({
    paths: f.vault,
    quota: nativeQuotaCodec,
    onStep: async (point) => {
      if (point === 'before-config-write')
        throw new Error('synthetic crash before rename')
    },
  })
  await expect(
    store.updateSettings((s) => ({ ...s, mainAccountId: f.mainRoute })),
  ).rejects.toThrow()
  await expect(stat(f.vault.config)).rejects.toMatchObject({ code: 'ENOENT' })
  await f.store.updateSettings((s) => ({ ...s, mainAccountId: f.mainRoute }))
  expect(JSON.parse(await readFile(f.vault.config, 'utf8'))).toMatchObject(
    preferences,
  )
  await f.assertLegacy()
})

test('routing seed rename failure is nonfatal, leaves no partial file or marker, and retry seeds completely', async () => {
  const f = await fixture()
  const originalRename = fs.rename
  const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === f.vault.routing) throw new Error('synthetic crash at rename')
    return originalRename(from, to)
  })
  deferCleanup(() => rename.mockRestore())
  expect((await f.readAndDrain()).mode).toBe('claustrum')
  await expect(stat(f.vault.routing)).rejects.toMatchObject({ code: 'ENOENT' })
  rename.mockRestore()
  await f.readAndDrain()
  expect(
    JSON.parse(await readFile(f.vault.routing, 'utf8')).vaultLegacySeed,
  ).toBe('complete')
  await f.assertLegacy()
})

test('completed routing seed adds no legacy or routing file reads to later Core snapshots', async () => {
  const f = await fixture()
  await f.readAndDrain()
  const read = spyOn(fs, 'readFile')
  const metadata = spyOn(fs, 'stat')
  deferCleanup(() => {
    read.mockRestore()
    metadata.mockRestore()
  })
  await f.readAndDrain()
  await f.readAndDrain()
  expect(
    metadata.mock.calls.filter(([path]) => path === f.vault.routing),
  ).toEqual([])
  const reads = read.mock.calls.map(([path]) => String(path))
  expect(
    reads.filter(
      (path) =>
        path === f.paths.legacyConfig ||
        path === f.legacyRouting ||
        path === f.vault.routing,
    ),
  ).toEqual([])
  // common-auth can reuse the unchanged parsed roster, so reads can be zero.
  expect(
    reads.filter((path) => path === f.vault.roster).length,
  ).toBeLessThanOrEqual(2)
})

test('malformed routing stays untouched while requests can still select an admitted account', async () => {
  const f = await fixture()
  const bytes = 'pre-existing malformed vault routing'
  await writeFile(f.vault.routing, bytes, { mode: 0o600 })
  expect((await f.readAndDrain()).mode).toBe('claustrum')
  expect(await readFile(f.vault.routing, 'utf8')).toBe(bytes)
  expect((await f.resolveAndDrain('session'))?.accountId).toBe(f.workRoute)
  expect(await readFile(f.vault.routing, 'utf8')).toBe(bytes)
  await f.assertLegacy()
})

test('first snapshot with existing settings completes while another writer still holds the roster lock', async () => {
  const f = await fixture()
  const existing = JSON.stringify({
    mainAccountId: f.mainRoute,
    claustrum: {
      primaryAccount: { credentialId: 'oauth:anthropic', accountId: mainUuid },
    },
    routing: { mode: 'fallback-first' },
  })
  await writeFile(f.vault.config, existing, { mode: 0o600 })
  const entered = gate()
  const release = gate()
  let holding = false
  const holder = mutateVaultRoster(f.vault.roster, async () => {
    holding = true
    entered.open()
    await release.wait
    holding = false
    return { result: undefined }
  })
  trackDetached(holder)
  await entered.wait
  try {
    const snapshot = await f.readAndDrain()
    expect(holding).toBe(true)
    expect(snapshot.settings.routing).toEqual({ mode: 'fallback-first' })
    expect(await readFile(f.vault.config, 'utf8')).toBe(existing)
  } finally {
    release.open()
    await holder
  }
  expect(holding).toBe(false)
  await f.assertLegacy()
}, 15_000)
