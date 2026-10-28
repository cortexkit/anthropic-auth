import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import type { ProviderAccountUuid } from '../claude-code.ts'
import {
  HOLDER_FILE_NAME,
  type HolderLiveness,
  HolderRegistrationError,
  resetNativeHolderRegistryForTests,
} from '../holder-registry.ts'
import type { PreNArtifactLocations } from '../layout-fence.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { createNativeLocalRuntimeReaders } from '../native-local-runtime-readers.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import { nativeQuotaCodec, toNativeQuotaMap } from '../native-quota-codec.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshObservation,
  nativeAccountProviderLock,
} from '../native-refresh-coordinator.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import {
  beginNativeEmptyInit,
  readNativeMigrationJournal,
} from '../pool-authority.ts'
import { captureNativeLocalPoolBinding } from '../pool-binding.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { nativeRelocationGuard } from '../relocation-guard.ts'
import { resetStateHomeServingGuardForTests } from '../state-home-serving-guard.ts'
import {
  type DecideStateLayoutOptions,
  decideOpenCodeStateLayout,
  type StateLayoutDecision,
} from '../state-layout-decision.ts'
import { StateLayoutRefusalError } from '../state-layout-errors.ts'
import {
  defaultStateLayoutFs,
  type StateLayoutFs,
  writeOwnerOnlyExclusive,
} from '../state-layout-io.ts'
import { StateLayoutCrash, type StateLayoutStep } from '../state-layout-move.ts'
import {
  LEGACY_STATE_LAYOUT,
  processStateLayout,
  readRelocationPointer,
  resetProcessStateLayoutsForTests,
} from '../state-layout-paths.ts'
import {
  RELOCATION_ROLES,
  readStateLayoutRecord,
} from '../state-layout-record.ts'

const roots: string[] = []

beforeEach(() => {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
})

afterEach(async () => {
  __setLogTestSink(null)
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

function credential(suffix: string) {
  return {
    type: 'oauth' as const,
    access: `access-${suffix}`,
    refresh: `refresh-${suffix}`,
    expires: 4_000_000_000_000,
  }
}

/** The data files of the closed list, by role, in the legacy layout. */
function oldFiles(paths: NativePoolPaths) {
  const vault = nativeVaultPaths(paths, LEGACY_STATE_LAYOUT)
  return {
    localPoolState: paths.state,
    localRuntime: paths.runtime,
    journal: paths.journal,
    localRoster: paths.roster,
    vaultStoreState: vault.state,
    vaultRuntime: vault.runtime,
    vaultRoster: vault.roster,
    vaultRouting: vault.routing,
  }
}

interface Machine {
  root: string
  home: string
  configDir: string
  env: NodeJS.ProcessEnv
  sub: string
  oldPaths: NativePoolPaths
  newPaths: NativePoolPaths
  artifacts: PreNArtifactLocations
  /** The bytes of every old data file at the start. */
  original: Record<string, string | undefined>
}

/**
 * A home folder whose default OpenCode config folder holds a migrated local
 * pool with one row (no identity unless given), a local and a vault runtime,
 * a custody roster and the vault files. Every file the move handles is
 * present unless `absent` names it.
 */
async function machine(
  options: {
    journal?: boolean
    identity?: string
    absent?: (keyof ReturnType<typeof oldFiles>)[]
    xdgStateHome?: string
  } = {},
): Promise<Machine> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'state-move-')))
  roots.push(root)
  const home = join(root, 'home')
  const configDir = join(home, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  const state = options.xdgStateHome ?? join(root, 'state')
  const env = { XDG_STATE_HOME: state }
  const oldPaths = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  const store = createNativePoolStore({
    paths: oldPaths,
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  await store.add({
    id: 'a',
    ...(options.identity ? { identity: options.identity } : {}),
    credential: credential('a'),
  })
  await store.close()
  if (options.journal !== false) await beginNativeEmptyInit(oldPaths)
  const files = oldFiles(oldPaths)
  const contents: Partial<Record<keyof typeof files, string>> = {
    localRuntime: '{"version":1,"note":"local runtime"}\n',
    localRoster: '{"roster":"local"}\n',
    // An empty vault store state, as common-auth leaves it.
    vaultStoreState: '{"accounts":{},"version":1}\n',
    vaultRuntime: '{"version":1,"note":"vault runtime"}\n',
    vaultRoster: '{"roster":"vault"}\n',
    vaultRouting: '{"routing":"vault","seeded":true}\n',
  }
  for (const [role, text] of Object.entries(contents))
    await writeFile(files[role as keyof typeof files], text, { mode: 0o600 })
  for (const role of options.absent ?? [])
    await rm(files[role], { force: true })
  const original: Record<string, string | undefined> = {}
  for (const [role, path] of Object.entries(files))
    original[role] = await readFile(path, 'utf8').catch(() => undefined)
  const sub = join(state, 'cortexkit', 'anthropic-auth', 'opencode')
  const newPaths = await resolveNativePoolPaths(
    oldPaths.legacyConfig,
    oldPaths.legacyState,
    { kind: 'state-home', dir: sub },
  )
  return {
    root,
    home,
    configDir,
    env,
    sub,
    oldPaths,
    newPaths,
    artifacts: {
      rpcRoots: [join(root, 'rpc')],
      rpcDirs: [],
      cacheKeepDirs: [join(root, 'cachekeep')],
    },
    original,
  }
}

/** Every pid is alive unless listed as dead. */
function liveness(dead: number[] = []): HolderLiveness {
  return {
    pidAlive: (pid) => !dead.includes(pid),
    incarnation: async () => null,
  }
}

/** A fresh process deciding the layout. */
async function decide(
  m: Machine,
  options: Partial<DecideStateLayoutOptions> = {},
): Promise<StateLayoutDecision> {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
  return decideOpenCodeStateLayout({
    role: 'opencode2',
    env: m.env,
    home: m.home,
    artifacts: m.artifacts,
    // Entries this test process left in a holder file belong to processes
    // that have since "exited": earlier decisions in the same test.
    liveness: liveness([process.pid]),
    timeouts: { layoutMs: 3_000, holderMs: 3_000, dataMs: 3_000 },
    // These tests exercise the move itself, which is off by default until
    // the release that ships it; the gate has its own tests.
    moveEnabled: true,
    ...options,
  })
}

function crashAt(step: StateLayoutStep) {
  return async (current: StateLayoutStep) => {
    if (current === step) throw new StateLayoutCrash(step)
  }
}

/** A pid the injected liveness reports alive. */
const OLDER_PID = 424_242

/** A live process of an older version, which writes an unstamped CacheKeep record. */
async function olderVersionRunning(m: Machine) {
  const dir = m.artifacts.cacheKeepDirs[0] as string
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${OLDER_PID}-older.json`)
  await writeFile(
    path,
    JSON.stringify({ version: 1, updatedAt: 1, sessions: [] }),
  )
  return path
}

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Which copies a process could serve now: the legacy copy (its pool state is
 * there, no barrier is up, and its journal authorizes it) and the state-home
 * copy (a committed record and the moved pool state). Exactly one must be.
 */
async function usableCopies(m: Machine) {
  const files = oldFiles(m.oldPaths)
  const copies: string[] = []
  const tombstoned =
    (await readRelocationPointer(files.localRuntime)) !== undefined ||
    (await readRelocationPointer(files.vaultRuntime)) !== undefined
  if (
    (await exists(files.localPoolState)) &&
    !tombstoned &&
    (await readNativeMigrationJournal(m.oldPaths).catch(() => undefined)) !==
      undefined
  )
    copies.push('legacy')
  const record = await readStateLayoutRecord(m.sub).catch(() => undefined)
  if (record?.phase === 'committed' && (await exists(m.newPaths.state)))
    copies.push('state-home')
  return copies
}

/** The pool state of whichever copy is usable. */
async function servedPoolState(m: Machine) {
  const [copy] = await usableCopies(m)
  return readFile(
    copy === 'legacy' ? m.oldPaths.state : m.newPaths.state,
    'utf8',
  )
}

/** The old folder's data files, by role. */
async function oldTree(m: Machine) {
  const tree: Record<string, string | undefined> = {}
  for (const [role, path] of Object.entries(oldFiles(m.oldPaths)))
    tree[role] = await readFile(path, 'utf8').catch(() => undefined)
  return tree
}

/** Data files of the closed list present in `<sub>`. */
async function subDataFiles(m: Machine) {
  const names = new Set(
    Object.values(oldFiles(m.oldPaths)).map((path) => path.split('/').pop()),
  )
  return (await readdir(m.sub).catch(() => [] as string[])).filter((name) =>
    names.has(name),
  )
}

test('a first start moves an idle dataset, keeps the storage ids, and serves only the new copy', async () => {
  const m = await machine()
  const decision = await decide(m)
  expect(decision.kind).toBe('state-home')
  expect(decision.layout).toEqual({ kind: 'state-home', dir: m.sub })
  expect(await usableCopies(m)).toEqual(['state-home'])
  // Byte copies under the same storage id: the journal reads back as valid.
  expect(await readNativeMigrationJournal(m.newPaths)).toMatchObject({
    kind: 'empty-init',
    storageId: m.oldPaths.storageId,
  })
  expect(m.newPaths.storageId).toBe(m.oldPaths.storageId)
  expect(await readFile(m.newPaths.state, 'utf8')).toBe(
    m.original.localPoolState as string,
  )
  const record = await readStateLayoutRecord(m.sub)
  expect(record).toMatchObject({ phase: 'committed', cleanup: 'done' })
  // Old copies are gone; both runtimes are tombstones naming the new folder.
  const files = oldFiles(m.oldPaths)
  expect(await exists(files.localPoolState)).toBe(false)
  expect(await exists(files.journal)).toBe(false)
  expect(await readRelocationPointer(files.localRuntime)).toMatchObject({
    relocatedTo: m.sub,
  })
  expect(await readRelocationPointer(files.vaultRuntime)).toMatchObject({
    relocatedTo: m.sub,
  })
  expect(
    JSON.parse(await readFile(join(m.sub, 'config-dir.json'), 'utf8')),
  ).toEqual({
    version: 1,
    identity: m.configDir,
  })
  for (const name of [
    'config-dir.json',
    'layout.json',
    'anthropic-auth-pool-state.json',
  ])
    expect((await lstat(join(m.sub, name))).mode & 0o777).toBe(0o600)
  // The process resolves the moved dataset from now on.
  expect(processStateLayout(m.oldPaths.legacyConfig)).toEqual({
    kind: 'state-home',
    dir: m.sub,
  })
  expect(
    await resolveNativePoolPaths(
      m.oldPaths.legacyConfig,
      m.oldPaths.legacyState,
    ),
  ).toEqual(m.newPaths)
  // Mandatory registration in the new folder.
  const holders = JSON.parse(
    await readFile(join(m.sub, HOLDER_FILE_NAME), 'utf8'),
  )
  expect(holders.entries).toContainEqual(
    expect.objectContaining({ pid: process.pid, kind: 'state-home' }),
  )
})

test('a fresh install with no data still installs both barriers', async () => {
  const m = await machine({ journal: false })
  for (const path of Object.values(oldFiles(m.oldPaths)))
    await rm(path, { force: true })
  await rm(m.oldPaths.config, { force: true })
  expect((await decide(m)).kind).toBe('state-home')
  const record = await readStateLayoutRecord(m.sub)
  expect(record?.barriers).toEqual({
    journal: 'absent',
    localRuntime: { original: null },
    vaultRuntime: { original: null },
  })
  expect(await readRelocationPointer(m.oldPaths.runtime)).toBeDefined()
})

test('a machine that never decides keeps the legacy layout with no change', async () => {
  const m = await machine()
  expect(processStateLayout(m.oldPaths.legacyConfig)).toBe(LEGACY_STATE_LAYOUT)
  expect(
    await resolveNativePoolPaths(
      m.oldPaths.legacyConfig,
      m.oldPaths.legacyState,
    ),
  ).toEqual(m.oldPaths)
  // The legacy guard still looks for tombstones; nothing is in conflict.
  await expect(
    nativeRelocationGuard(m.oldPaths).assertNotRelocated(),
  ).resolves.toBeUndefined()
  expect(await exists(m.sub)).toBe(false)
})

test('a process with a path override never moves and never writes the marker', async () => {
  const m = await machine()
  const before = await oldTree(m)
  const decision = await decide(m, {
    env: {
      ...m.env,
      OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(m.root, 'routing.json'),
    },
  })
  expect(decision.kind).toBe('legacy')
  expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
  expect(await oldTree(m)).toEqual(before)
})

test('the fence: a live holder, a malformed holder file, or a live older-version artifact keeps the dataset in place', async () => {
  const cases: [
    string,
    (m: Machine) => Promise<void>,
    Partial<DecideStateLayoutOptions>?,
  ][] = [
    [
      'live holder of another process',
      async (m) => {
        await writeFile(
          join(m.configDir, HOLDER_FILE_NAME),
          JSON.stringify({
            version: 1,
            entries: [
              {
                pid: OLDER_PID,
                incarnation: null,
                role: 'pi',
                kind: 'pi',
                files: [m.oldPaths.state],
              },
            ],
          }),
        )
      },
    ],
    [
      'live holder of this pid in another copy of the code',
      async (m) => {
        await mkdir(m.sub, { recursive: true })
        await writeFile(
          join(m.sub, HOLDER_FILE_NAME),
          JSON.stringify({
            version: 1,
            entries: [
              {
                // This very process, registered by another copy of the code.
                pid: process.pid,
                incarnation: null,
                instance: 'another-copy',
                role: 'cli',
                kind: 'explicit',
                files: [m.newPaths.state],
              },
            ],
          }),
        )
      },
      // This process is alive: a mover never excludes its own pid.
      { liveness: liveness([]) },
    ],
    [
      'live unregistered older version (CacheKeep record)',
      async (m) => void (await olderVersionRunning(m)),
    ],
    [
      'live unregistered older version (RPC port file)',
      async (m) => {
        const dir = join(m.root, 'rpc', 'project')
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, `port-${OLDER_PID}.json`),
          JSON.stringify({ port: 1, token: 't', pid: OLDER_PID, startedAt: 0 }),
        )
      },
    ],
    [
      'unreadable port-file folder',
      async (m) => {
        await writeFile(join(m.root, 'rpc'), 'not a folder')
      },
    ],
  ]
  for (const [name, arrange, options] of cases) {
    const m = await machine()
    await arrange(m)
    const before = await oldTree(m)
    const decision = await decide(m, options)
    expect({ name, kind: decision.kind }).toEqual({ name, kind: 'legacy' })
    expect(await oldTree(m)).toEqual(before)
    expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
    expect(await subDataFiles(m)).toEqual([])
  }
})

test('a malformed holder file keeps the dataset in place and, since registration is mandatory, refuses', async () => {
  const m = await machine()
  await writeFile(join(m.configDir, HOLDER_FILE_NAME), '{not json')
  const before = await oldTree(m)
  await expect(decide(m)).rejects.toMatchObject({ code: 'malformed' })
  expect(await oldTree(m)).toEqual(before)
  expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
  expect(await readFile(join(m.configDir, HOLDER_FILE_NAME), 'utf8')).toBe(
    '{not json',
  )
})

test('the fence: dead pids and stamped artifacts do not block', async () => {
  const m = await machine()
  await writeFile(
    join(m.configDir, HOLDER_FILE_NAME),
    JSON.stringify({
      version: 1,
      entries: [
        {
          pid: 7,
          incarnation: null,
          role: 'pi',
          kind: 'pi',
          files: [m.oldPaths.state],
        },
      ],
    }),
  )
  const dir = m.artifacts.cacheKeepDirs[0] as string
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${OLDER_PID}-new.json`),
    JSON.stringify({
      version: 1,
      updatedAt: 1,
      sessions: [],
      writer: { protocol: 1, release: '2.4.0' },
    }),
  )
  expect((await decide(m, { liveness: liveness([process.pid, 7]) })).kind).toBe(
    'state-home',
  )
})

test('a legacy holder registered under another XDG_STATE_HOME still blocks the move', async () => {
  const m = await machine()
  // The holder file lives beside the data, so the holder's state root is irrelevant.
  await writeFile(
    join(m.configDir, HOLDER_FILE_NAME),
    JSON.stringify({
      version: 1,
      entries: [
        {
          pid: OLDER_PID,
          incarnation: null,
          role: 'opencode1',
          kind: 'legacy',
          files: [m.oldPaths.runtime],
        },
      ],
    }),
  )
  const decision = await decide(m, {
    env: { XDG_STATE_HOME: join(m.root, 'other-root') },
  })
  expect(decision.kind).toBe('legacy')
})

test('a configured file that is a symlink, even to a file in the same folder, keeps the dataset in place untouched', async () => {
  const m = await machine()
  const tokens = join(m.configDir, 'tokens.json')
  await rename(m.oldPaths.state, tokens)
  await symlink('tokens.json', m.oldPaths.state)
  const snapshot = async () => ({
    tree: await oldTree(m),
    link: await readlink(m.oldPaths.state),
    tokens: await readFile(tokens, 'utf8'),
  })
  const before = await snapshot()
  const decision = await decide(m)
  expect(decision.kind).toBe('legacy')
  if (decision.kind === 'legacy')
    expect(decision.reasons.join(' ')).toContain(m.oldPaths.state)
  expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
  expect(await subDataFiles(m)).toEqual([])
  expect(await snapshot()).toEqual(before)
  expect((await lstat(m.oldPaths.state)).isSymbolicLink()).toBe(true)
})

test('an older version found after the copies rolls the move back to legacy', async () => {
  const m = await machine()
  const before = await oldTree(m)
  const decision = await decide(m, {
    onStep: async (step) => {
      if (step === 'copies-flushed') await olderVersionRunning(m)
    },
  })
  expect(decision.kind).toBe('legacy')
  expect(await oldTree(m)).toEqual(before)
  expect(await subDataFiles(m)).toEqual([])
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('rolled-back')
})

test('locks are taken in the order of the refresh drain', async () => {
  const m = await machine({ identity: 'account-a' })
  const events: NativeLockEvent[] = []
  await decide(m, { onLockEvent: (event) => events.push(event) })
  const acquired = events
    .filter((event) => event.type === 'acquired')
    .map((event) => `${event.name}@${event.path.split('/').pop()}`)
  const local = 'anthropic-auth-pool-state.json'
  const vault = 'anthropic-auth-vault-store-state.json'
  // Core's per-account provider lock for the one identified row, named by
  // its own rule: sha256 of the storage id and the identity.
  const providerLocal = `native-account-provider-${createHash('sha256')
    .update(JSON.stringify([m.oldPaths.storageId, 'account-a']))
    .digest('hex')}@${local}`
  expect(acquired).toEqual([
    'runtime-layout@layout.json',
    `holders@${HOLDER_FILE_NAME}`,
    `holders@${HOLDER_FILE_NAME}`,
    'native-migration@anthropic-auth-migration.json',
    `row-a@${local}`,
    `row-account-a@${local}`,
    `provider-anthropic@${local}`,
    providerLocal,
    'pool-config@anthropic-auth-pool.json',
    `pool-state@${local}`,
    'claustrum-roster-write@anthropic-auth-custody-roster.json',
    'native-runtime@anthropic-auth-native-state.json',
    `provider-anthropic@${vault}`,
    'pool-config@anthropic-auth-vault-settings.json',
    `pool-state@${vault}`,
    'claustrum-roster@anthropic-auth-vault-roster.json',
    'claustrum-roster-write@anthropic-auth-vault-roster.json',
    'native-runtime@anthropic-auth-vault-state.json',
    'write@anthropic-auth-vault-routing-state.json',
  ])
  // Holder locks are sorted by path; no data lock precedes them.
  const holders = events.filter(
    (event) => event.name === 'holders' && event.type === 'acquired',
  )
  expect(holders.map((event) => event.path)).toEqual(
    [join(m.configDir, HOLDER_FILE_NAME), join(m.sub, HOLDER_FILE_NAME)].sort(),
  )
})

test('row locks are taken in the raw-key order common-auth publication uses, which encoding would change', async () => {
  const m = await machine()
  const store = createNativePoolStore({
    paths: m.oldPaths,
    quota: nativeQuotaCodec,
  })
  // Legal ids whose order flips once encoded: '-' < ':' but '%3A' < '-'.
  for (const id of ['a:b', 'a-b'])
    await store.add({ id, credential: credential(id) })
  await store.close()
  const rows: string[] = []
  await decide(m, {
    onLockEvent: (event) => {
      if (
        event.type === 'acquired' &&
        event.path === m.oldPaths.state &&
        event.name.startsWith('row-')
      )
        rows.push(event.name)
    },
  })
  expect(rows).toEqual(
    ['a', 'a-b', 'a:b'].map((key) => `row-${encodeURIComponent(key)}`),
  )
})

/**
 * Core's refresh coordinator over the old pool, with every policy hook
 * allowing the refresh. `exchange` stands in for the provider's token
 * endpoint and `learn` for the account lookup after it.
 */
function coordinatorFor(
  m: Machine,
  options: {
    exchange: () => Promise<void>
    learn: string
    onLockEvent?: (event: NativeLockEvent) => void
  },
) {
  const observations: NativeRefreshObservation[] = []
  const coordinator = createNativeRefreshCoordinator({
    paths: m.oldPaths,
    quota: nativeQuotaCodec,
    onLockEvent: options.onLockEvent,
    refreshToken: async () => {
      await options.exchange()
      return { ...credential('successor'), expiresIn: 3600 }
    },
    resolveIdentity: async () => ({
      deviceId: 'device',
      sessionId: 'session',
      accountUuid: options.learn as ProviderAccountUuid,
    }),
    readRestrictions: async (subject) => ({
      restriction: { status: 'allowed' },
      context: {
        subject,
        runtimeBinding: subject.binding,
        refreshErrorClearedAt: null,
        quotaErrorClearedAt: null,
        quotaErrorGeneration: null,
      },
    }),
    readAdmission: async () => ({ status: 'unproven' }),
    reconcile: async (event) => {
      observations.push(event)
    },
  })
  return {
    observations,
    async refresh() {
      const store = createNativePoolStore({
        paths: m.oldPaths,
        quota: nativeQuotaCodec,
      })
      const read = await store.read()
      await store.close()
      if (read.status !== 'ready') throw new Error('the pool is not ready')
      const row = read.rows.find((candidate) => candidate.id === 'a')
      if (!row) throw new Error('row a is missing')
      return coordinator.authorize({
        intent: 'refresh',
        mode: 'local',
        binding: captureNativeLocalPoolBinding(m.oldPaths, row),
      })
    },
  }
}

/** The moved pool state, as compact JSON. */
async function movedRow(m: Machine) {
  return JSON.stringify(JSON.parse(await readFile(m.newPaths.state, 'utf8')))
}

test("a refresh of an identified row through Core's coordinator, under Core's per-account provider lock, is drained: the move waits and copies the successor", async () => {
  const m = await machine({ identity: 'account-a' })
  const provider = nativeAccountProviderLock(m.oldPaths, 'account-a')
  let exchanging!: () => void
  const inExchange = new Promise<void>((resolve) => {
    exchanging = resolve
  })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const acquired: string[] = []
  const c = coordinatorFor(m, {
    learn: 'account-a',
    exchange: async () => {
      exchanging()
      await finished
    },
    onLockEvent: (event) => {
      if (event.type === 'acquired') acquired.push(event.name)
    },
  })
  const refreshing = c.refresh()
  await inExchange
  // The refresh is in its token exchange under Core's provider lock for the
  // account, not the default provider lock.
  expect(acquired).toContain(provider.name)
  expect(acquired).not.toContain('provider-anthropic')
  let contended: NativeLockEvent | undefined
  const deciding = decide(m, {
    onLockEvent: (event) => {
      if (event.type === 'contended' && !contended) {
        contended = event
        finish()
      }
    },
    timeouts: { layoutMs: 10_000, holderMs: 10_000, dataMs: 10_000 },
  })
  await refreshing
  const decision = await deciding
  expect(contended?.name).toBe('row-account-a')
  expect(c.observations).toContainEqual(
    expect.objectContaining({ status: 'persisted' }),
  )
  expect(decision.kind).toBe('state-home')
  const moved = await movedRow(m)
  expect(moved).toContain('refresh-successor')
  expect(moved).not.toContain('refresh-a"')
})

test("a refresh that learns its row's identity waits for Core's handoff lock while holding the row; the move waits for it and copies the successor with its identity", async () => {
  const m = await machine()
  const learned = 'account-learned'
  const handoff = nativeAccountProviderLock(m.oldPaths, learned)
  // Another refresh of the learned account holds its provider lock, so this
  // refresh, after its exchange, waits for the handoff while it still holds
  // row-a and the default provider lock.
  let releaseHandoff!: () => void
  const handoffReleased = new Promise<void>((resolve) => {
    releaseHandoff = resolve
  })
  let handoffHeld!: () => void
  const holdingHandoff = new Promise<void>((resolve) => {
    handoffHeld = resolve
  })
  const holder = withLock(
    handoff.path,
    { name: handoff.name, ttlMs: 10_000, timeoutMs: 1_000, renew: true },
    async () => {
      handoffHeld()
      await handoffReleased
    },
  )
  await holdingHandoff
  let waiting!: () => void
  const waitingForHandoff = new Promise<void>((resolve) => {
    waiting = resolve
  })
  const c = coordinatorFor(m, {
    learn: learned,
    exchange: async () => {},
    onLockEvent: (event) => {
      if (event.type === 'contended' && event.name === handoff.name) waiting()
    },
  })
  const refreshing = c.refresh()
  await waitingForHandoff
  let contended: NativeLockEvent | undefined
  const deciding = decide(m, {
    onLockEvent: (event) => {
      if (event.type === 'contended' && !contended) {
        contended = event
        releaseHandoff()
      }
    },
    timeouts: { layoutMs: 10_000, holderMs: 10_000, dataMs: 10_000 },
  })
  await refreshing
  const decision = await deciding
  await holder
  expect(contended?.name).toBe('row-a')
  expect(c.observations).toContainEqual(
    expect.objectContaining({
      status: 'persisted',
      handoff: 'acquired',
      identity: learned,
    }),
  )
  expect(decision.kind).toBe('state-home')
  const moved = await movedRow(m)
  expect(moved).toContain('refresh-successor')
  expect(moved).toContain(learned)
  expect(moved).not.toContain('refresh-a"')
})

test('after a move, a late refresh against the old paths finds no credential and makes no provider call', async () => {
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  const late = createNativePoolStore({
    paths: m.oldPaths,
    quota: nativeQuotaCodec,
  })
  let calls = 0
  await expect(
    late.refresh('a', async () => {
      calls++
      return credential('late')
    }),
  ).rejects.toBeDefined()
  expect(calls).toBe(0)
  await late.close()
})

/** Every named step of a move, in order: every copy and every cleanup role. */
const MOVE_STEPS: StateLayoutStep[] = [
  'fence-checked',
  'locks-held',
  'config-dir-written',
  'preparing-written',
  ...RELOCATION_ROLES.map((role) => `copied:${role}` as const),
  'copies-flushed',
  'artifacts-checked',
  'journal-set-aside',
  'local-runtime-tombstoned',
  'vault-runtime-tombstoned',
  'old-dir-flushed',
  'verified',
  'committed',
  ...RELOCATION_ROLES.filter(
    (role) => role !== 'localRuntime' && role !== 'vaultRuntime',
  ).map((role) => `cleanup:${role}` as const),
  'cleanup-recorded',
]

test('a crash at every step of the move recovers to exactly one usable copy holding the original credentials', async () => {
  for (const step of MOVE_STEPS) {
    const m = await machine()
    await expect(decide(m, { onStep: crashAt(step) })).rejects.toBeInstanceOf(
      StateLayoutCrash,
    )
    // On disk at most one copy is usable; never two.
    expect({ step, copies: (await usableCopies(m)).length <= 1 }).toEqual({
      step,
      copies: true,
    })
    const decision = await decide(m)
    expect({ step, kind: decision.kind }).toEqual({ step, kind: 'state-home' })
    expect({ step, copies: await usableCopies(m) }).toEqual({
      step,
      copies: ['state-home'],
    })
    expect(await servedPoolState(m)).toBe(m.original.localPoolState as string)
    expect(await readFile(m.newPaths.runtime, 'utf8')).toBe(
      m.original.localRuntime as string,
    )
    expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
  }
})

test('a crash after a rename landed but before its folder was flushed, at every flush of the move, recovers to exactly one usable copy', async () => {
  const base = defaultStateLayoutFs()
  /**
   * Every folder flush of an undisturbed move, in order. The list is written
   * out from the design rather than counted from the code, so a flush that
   * goes missing fails here instead of shrinking the matrix.
   */
  const flushSites = (m: Machine) => {
    const anthropic = join(m.root, 'state', 'cortexkit', 'anthropic-auth')
    return [
      // The new subfolder's entry in each parent it was created in.
      anthropic,
      join(m.root, 'state', 'cortexkit'),
      join(m.root, 'state'),
      m.root,
      m.sub, // config-dir.json and the holder file
      m.sub, // the preparing record
      m.sub, // the copies
      m.configDir, // the barriers
      m.sub, // the commit
      m.configDir, // the removal of the old copies
      m.sub, // the record of that removal
    ]
  }
  const probe = await machine()
  const flushed: string[] = []
  const recording: StateLayoutFs = {
    ...base,
    syncDirectory: async (dir) => {
      flushed.push(dir)
      await base.syncDirectory(dir)
    },
  }
  expect((await decide(probe, { fs: recording })).kind).toBe('state-home')
  expect(flushed).toEqual(flushSites(probe))
  const total = flushSites(probe).length
  for (let flush = 1; flush <= total; flush++) {
    const m = await machine()
    let calls = 0
    let last: StateLayoutStep = 'old-holders-locking'
    // The process dies at the flush: every rename before it has landed and
    // none since the previous flush is durable yet.
    const fs: StateLayoutFs = {
      ...base,
      syncDirectory: async (dir) => {
        if (++calls === flush) throw new StateLayoutCrash(last)
        await base.syncDirectory(dir)
      },
    }
    await expect(
      decide(m, {
        fs,
        onStep: (step) => {
          last = step
        },
      }),
    ).rejects.toBeInstanceOf(StateLayoutCrash)
    expect({
      flush,
      at: last,
      copies: (await usableCopies(m)).length <= 1,
    }).toEqual({
      flush,
      at: last,
      copies: true,
    })
    const decision = await decide(m)
    expect({ flush, at: last, kind: decision.kind }).toEqual({
      flush,
      at: last,
      kind: 'state-home',
    })
    expect({ flush, copies: await usableCopies(m) }).toEqual({
      flush,
      copies: ['state-home'],
    })
    expect(await servedPoolState(m)).toBe(m.original.localPoolState as string)
    expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
  }
})

test('a crash before the commit followed by a blocked restart rolls back to the exact original tree', async () => {
  for (const step of MOVE_STEPS.slice(0, MOVE_STEPS.indexOf('committed'))) {
    for (const journal of [true, false]) {
      // Without a journal there is no journal copy to stop at.
      if (!journal && step === 'copied:journal') continue
      const m = await machine({ journal })
      const before = await oldTree(m)
      await expect(decide(m, { onStep: crashAt(step) })).rejects.toBeInstanceOf(
        StateLayoutCrash,
      )
      await olderVersionRunning(m)
      const decision = await decide(m)
      expect({ step, journal, kind: decision.kind }).toEqual({
        step,
        journal,
        kind: 'legacy',
      })
      expect({ step, journal, tree: await oldTree(m) }).toEqual({
        step,
        journal,
        tree: before,
      })
      expect({ step, journal, sub: await subDataFiles(m) }).toEqual({
        step,
        journal,
        sub: [],
      })
      expect(await usableCopies(m)).toEqual(journal ? ['legacy'] : [])
    }
  }
})

test('a crash after the commit never goes back to legacy', async () => {
  for (const step of MOVE_STEPS.slice(MOVE_STEPS.indexOf('committed'))) {
    const m = await machine()
    await expect(decide(m, { onStep: crashAt(step) })).rejects.toBeInstanceOf(
      StateLayoutCrash,
    )
    // A newer older version starting now would refuse: both barriers are up.
    expect(await readRelocationPointer(m.oldPaths.runtime)).toBeDefined()
    expect(await exists(m.oldPaths.journal)).toBe(false)
    await olderVersionRunning(m)
    expect((await decide(m)).kind).toBe('state-home')
    expect(await usableCopies(m)).toEqual(['state-home'])
  }
})

const ROLLBACK_STEPS: StateLayoutStep[] = [
  'rollback:journal',
  'rollback:localRuntime',
  'rollback:vaultRuntime',
  'rollback:old-dir-flushed',
  'rollback:destination-removed',
  'rollback:sub-flushed',
  'rolled-back',
]

test('a crash at every step of a rollback converges on the next start', async () => {
  for (const step of ROLLBACK_STEPS) {
    const m = await machine()
    const before = await oldTree(m)
    await expect(
      decide(m, { onStep: crashAt('old-dir-flushed') }),
    ).rejects.toBeInstanceOf(StateLayoutCrash)
    await olderVersionRunning(m)
    await expect(decide(m, { onStep: crashAt(step) })).rejects.toBeInstanceOf(
      StateLayoutCrash,
    )
    const decision = await decide(m)
    expect({ step, kind: decision.kind }).toEqual({ step, kind: 'legacy' })
    expect({ step, tree: await oldTree(m) }).toEqual({ step, tree: before })
    expect({ step, sub: await subDataFiles(m) }).toEqual({ step, sub: [] })
    expect(await usableCopies(m)).toEqual(['legacy'])
  }
})

test('rollback leaves a runtime written by a legacy process alone', async () => {
  const m = await machine()
  // The mover died after copying, before any barrier.
  await expect(
    decide(m, { onStep: crashAt('copies-flushed') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  await writeFile(m.oldPaths.runtime, '{"version":1,"note":"written later"}\n')
  await olderVersionRunning(m)
  expect((await decide(m)).kind).toBe('legacy')
  expect(await readFile(m.oldPaths.runtime, 'utf8')).toBe(
    '{"version":1,"note":"written later"}\n',
  )
  // Its copy no longer matches a source, but the source still exists and the
  // copy hashes to the record, so it is removed; nothing else is.
  expect(await subDataFiles(m)).toEqual([])
})

test('rollback refuses when the journal is at both names', async () => {
  const m = await machine()
  await expect(
    decide(m, { onStep: crashAt('journal-set-aside') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  const record = await readStateLayoutRecord(m.sub)
  await writeFile(
    m.oldPaths.journal,
    await readFile(`${m.oldPaths.journal}.moving-${record?.attempt}`),
  )
  await expect(decide(m)).rejects.toMatchObject({ code: 'unsafe' })
})

test('an old pool state changed behind the barriers rolls back and keeps the newest bytes', async () => {
  const m = await machine()
  const changed = `${m.original.localPoolState}\n`
  const decision = await decide(m, {
    onStep: async (step) => {
      // A writer whose lease was lost renames past the barriers.
      if (step === 'old-dir-flushed') await writeFile(m.oldPaths.state, changed)
    },
  })
  expect(decision.kind).toBe('legacy')
  expect(await readFile(m.oldPaths.state, 'utf8')).toBe(changed)
  expect(await subDataFiles(m)).toEqual([])
  expect(await usableCopies(m)).toEqual(['legacy'])
})

test('a changed or new data file in the state folder rolls back, is kept, and stops the next move', async () => {
  for (const change of ['changed copy', 'new file'] as const) {
    const m = await machine({ absent: ['vaultRoster'] })
    const decision = await decide(m, {
      onStep: async (step) => {
        if (step !== 'old-dir-flushed') return
        if (change === 'changed copy')
          await appendFile(m.newPaths.roster, 'edited by hand\n')
        else
          await writeFile(join(m.sub, 'anthropic-auth-vault-roster.json'), '{}')
      },
    })
    expect(decision.kind).toBe('legacy')
    expect(await usableCopies(m)).toEqual(['legacy'])
    const kept =
      change === 'changed copy'
        ? 'anthropic-auth-custody-roster.json'
        : 'anthropic-auth-vault-roster.json'
    expect(await subDataFiles(m)).toEqual([kept])
    const next = await decide(m)
    expect(next.kind).toBe('legacy')
    if (next.kind === 'legacy')
      expect(next.reasons.join(' ')).toContain('unexpected anthropic-auth data')
  }
})

test('a changed state-folder runtime copy behind its tombstone refuses to start and names the file', async () => {
  const m = await machine()
  const attempt = decide(m, {
    onStep: async (step) => {
      if (step === 'vault-runtime-tombstoned')
        await appendFile(m.newPaths.runtime, 'edited\n')
    },
  })
  await expect(attempt).rejects.toBeInstanceOf(StateLayoutRefusalError)
  await expect(attempt).rejects.toMatchObject({
    code: 'unsafe',
    paths: [m.newPaths.runtime],
  })
})

test('a failed commit write rolls back to legacy', async () => {
  const m = await machine()
  const layout = join(m.sub, 'layout.json')
  let publications = 0
  const fs: StateLayoutFs = {
    ...defaultStateLayoutFs(),
    rename: async (from, to) => {
      if (to === layout && ++publications === 2)
        throw Object.assign(new Error('injected'), { code: 'EIO' })
      await defaultStateLayoutFs().rename(from, to)
    },
  }
  const before = await oldTree(m)
  const decision = await decide(m, { fs })
  expect(decision.kind).toBe('legacy')
  expect(await oldTree(m)).toEqual(before)
  expect((await readStateLayoutRecord(m.sub))?.phase).toBe('rolled-back')
})

/**
 * A move on a Windows filesystem seam: no directory flush, and the old pool
 * state's unlink fails with a sharing violation as `busy` says. Counts the
 * unlink attempts on the old pool state.
 */
function windowsFs(
  m: Machine,
  busy: (attempt: number) => Promise<boolean>,
): { fs: StateLayoutFs; attempts: () => number; flushes: () => number } {
  let clock = 0
  let flushes = 0
  let attempts = 0
  const base = defaultStateLayoutFs('win32')
  return {
    attempts: () => attempts,
    flushes: () => flushes,
    fs: {
      ...base,
      // Owner-only files are created the POSIX way on the test machine.
      createOwnerOnly: async (path, bytes) => {
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      },
      syncDirectory: async (dir) => {
        flushes++
        await base.syncDirectory(dir)
      },
      unlink: async (path) => {
        if (path === m.oldPaths.state && (await busy(++attempts)))
          throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        await defaultStateLayoutFs().unlink(path)
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    },
  }
}

test('Windows: no directory flush, and a transient sharing violation is retried until the unlink succeeds', async () => {
  // The win32 flush is a no-op even for a folder that doesn't exist.
  await expect(
    defaultStateLayoutFs('win32').syncDirectory(join(tmpdir(), 'missing')),
  ).resolves.toBeUndefined()
  const m = await machine()
  const win = windowsFs(m, async (attempt) => attempt <= 2)
  expect((await decide(m, { fs: win.fs })).kind).toBe('state-home')
  expect(win.flushes()).toBeGreaterThan(0)
  expect(win.attempts()).toBe(3)
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
  expect(await exists(m.oldPaths.state)).toBe(false)
})

test('Windows move stages use the complete native write without a Node reopen', async () => {
  const m = await machine()
  const binaryRoster = Buffer.from([0, 0xff, 0xc3, 0x28, 13, 10])
  await writeFile(m.oldPaths.roster, binaryRoster)
  const writes: { path: string; bytes: Buffer }[] = []
  let opens = 0
  const fs: StateLayoutFs = {
    ...defaultStateLayoutFs('win32'),
    createOwnerOnly: (path, bytes) =>
      writeOwnerOnlyExclusive(path, bytes, 'win32', {
        ownership: {
          privateFiles: {
            verifyOwnerOnly: async () => ({ ok: true }),
            readPrivateFile: readFile,
            createPrivateFile: async (path, bytes) => {
              writes.push({ path, bytes: Buffer.from(bytes!) })
              await writeFile(path, bytes!, { flag: 'wx', mode: 0o600 })
            },
          },
        },
        open: async () => {
          opens++
          throw new Error('A native-written move stage must not be reopened')
        },
      }),
  }
  const decision = await decide(m, { fs })
  expect(decision.kind).toBe('state-home')
  if (decision.kind !== 'state-home') throw new Error('move did not commit')
  expect(decision.record.phase).toBe('committed')
  expect(decision.record.cleanup).toBe('done')
  expect(opens).toBe(0)
  const markers = writes.filter((file) =>
    file.path.startsWith(join(m.sub, 'config-dir.json.')),
  )
  expect(markers).toHaveLength(1)
  expect(JSON.parse(markers[0]!.bytes.toString('utf8'))).toEqual({
    version: 1,
    identity: decision.dataset.identity,
  })
  expect(writes.every((file) => file.bytes.length > 0)).toBe(true)
  expect(new Set(writes.map((file) => file.path)).size).toBe(writes.length)
  expect(await readFile(m.newPaths.roster)).toEqual(binaryRoster)
})

test('Windows: a retry checks the file again first, so a file changed between attempts is kept and refused', async () => {
  const m = await machine()
  const changed = `${m.original.localPoolState} `
  const win = windowsFs(m, async (attempt) => {
    if (attempt > 2) return false
    // Another writer replaces the old copy while the unlink is refused.
    await writeFile(m.oldPaths.state, changed)
    return true
  })
  await expect(decide(m, { fs: win.fs })).rejects.toMatchObject({
    code: 'conflict',
    paths: [m.oldPaths.state, m.newPaths.state],
  })
  // The retry saw the change and did not unlink again.
  expect(win.attempts()).toBe(1)
  expect(await readFile(m.oldPaths.state, 'utf8')).toBe(changed)
})

test('Windows: an exhausted sharing-violation retry leaves cleanup pending in state-home, and the next start finishes it', async () => {
  const m = await machine()
  const win = windowsFs(m, async () => true)
  expect((await decide(m, { fs: win.fs })).kind).toBe('state-home')
  expect(win.attempts()).toBeGreaterThan(1)
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('pending')
  // The kept old copy is the verified one, behind the barriers: not a conflict.
  expect(await usableCopies(m)).toEqual(['state-home'])
  expect((await decide(m)).kind).toBe('state-home')
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
})

test('each phase is flushed before the next begins', async () => {
  const m = await machine()
  const log: string[] = []
  const base = defaultStateLayoutFs()
  const name = (path: string) =>
    path.startsWith(m.sub)
      ? `sub/${path.slice(m.sub.length + 1)}`
      : `old/${path.split('/').pop()}`
  const fs: StateLayoutFs = {
    ...base,
    rename: async (from, to) => {
      log.push(`rename ${name(to)}`)
      await base.rename(from, to)
    },
    unlink: async (path) => {
      log.push(`unlink ${name(path)}`)
      await base.unlink(path)
    },
    syncDirectory: async (dir) => {
      log.push(
        dir === m.sub
          ? 'flush sub'
          : dir === m.configDir
            ? 'flush old'
            : 'flush other',
      )
      await base.syncDirectory(dir)
    },
  }
  expect((await decide(m, { fs })).kind).toBe('state-home')
  // Every event the order below compares happened.
  for (const entry of [
    'rename old/anthropic-auth-native-state.json',
    'rename old/anthropic-auth-vault-state.json',
    'rename sub/anthropic-auth-pool-state.json',
    'rename sub/anthropic-auth-vault-state.json',
    'rename sub/layout.json',
    'unlink old/anthropic-auth-pool-state.json',
    'flush old',
    'flush sub',
  ])
    expect(log).toContain(entry)
  const at = (entry: string, from = 0) => log.indexOf(entry, from)
  const commit = log.findIndex(
    (entry, index) =>
      entry === 'rename sub/layout.json' &&
      index > at('rename old/anthropic-auth-vault-state.json'),
  )
  // Barriers, then the old folder's flush, then the commit, then its flush,
  // then the first unlink of an old copy.
  expect(at('rename old/anthropic-auth-native-state.json')).toBeLessThan(
    at('flush old'),
  )
  expect(at('rename old/anthropic-auth-vault-state.json')).toBeLessThan(
    at('flush old'),
  )
  expect(at('flush old')).toBeLessThan(commit)
  expect(at('flush sub', commit)).toBeGreaterThan(commit)
  expect(at('unlink old/anthropic-auth-pool-state.json')).toBeGreaterThan(
    at('flush sub', commit),
  )
  // Every copy is flushed before the barriers.
  expect(at('rename sub/anthropic-auth-pool-state.json')).toBeLessThan(
    at('flush sub', at('rename sub/anthropic-auth-vault-state.json')),
  )
  expect(
    at('flush sub', at('rename sub/anthropic-auth-vault-state.json')),
  ).toBeLessThan(at('rename old/anthropic-auth-native-state.json'))
})

test('changed old pool-state bytes at cleanup are a fatal conflict: both copies kept, serving refused', async () => {
  const m = await machine()
  await expect(
    decide(m, { onStep: crashAt('committed') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  // A writer that ignored every lock and barrier changed the old copy.
  const changed = `${m.original.localPoolState} `
  await writeFile(m.oldPaths.state, changed)
  const attempt = decide(m)
  await expect(attempt).rejects.toBeInstanceOf(StateLayoutRefusalError)
  await expect(attempt).rejects.toMatchObject({
    code: 'conflict',
    paths: [m.oldPaths.state, m.newPaths.state],
  })
  await expect(attempt).rejects.toThrow(m.oldPaths.state)
  await expect(attempt).rejects.toThrow(m.newPaths.state)
  expect(await readFile(m.oldPaths.state, 'utf8')).toBe(changed)
  expect(await readFile(m.newPaths.state, 'utf8')).toBe(
    m.original.localPoolState as string,
  )
  expect(await readStateLayoutRecord(m.sub)).toMatchObject({
    cleanup: 'conflict',
    conflict: [{ old: m.oldPaths.state, new: m.newPaths.state }],
  })
  // Once a person removes the copy they don't trust, the next start serves.
  await rm(m.oldPaths.state)
  expect((await decide(m)).kind).toBe('state-home')
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('done')
})

test("a local refresh's in-callback runtime read refuses once the dataset is in conflict, before any provider call", async () => {
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  // The read a refresh makes inside its callback, under the row and provider
  // locks. The serving runtime's own refusal is tested with a real runtime in
  // state-layout-authorization.test.ts.
  const readers = createNativeLocalRuntimeReaders({
    paths: m.newPaths,
    externalPolicy: () => ({ status: 'allowed' }),
  } as Parameters<typeof createNativeLocalRuntimeReaders>[0])
  const read = () =>
    readers.readRestrictions({
      binding: { kind: 'local', storageId: m.newPaths.storageId, rowId: 'a' },
    } as never)
  // An old copy of the credentials is back in the config folder.
  await writeFile(m.oldPaths.state, m.original.localPoolState as string)
  await expect(read()).rejects.toMatchObject({
    code: 'conflict',
    paths: [m.oldPaths.state, m.newPaths.state],
  })
  await rm(m.oldPaths.state)
  await expect(
    nativeRelocationGuard(m.newPaths).assertNotRelocated(),
  ).resolves.toBeUndefined()
})

test('a changed set-aside journal found by cleanup survives a later failed unlink: recorded as a conflict and refused', async () => {
  for (const recordWrite of ['succeeds', 'fails'] as const) {
    const m = await machine()
    await expect(
      decide(m, { onStep: crashAt('committed') }),
    ).rejects.toBeInstanceOf(StateLayoutCrash)
    const record = await readStateLayoutRecord(m.sub)
    const moving = `${m.oldPaths.journal}.moving-${record?.attempt}`
    // A writer that ignored every lock changed the journal the move set aside.
    await appendFile(moving, ' ')
    const changed = await readFile(moving, 'utf8')
    const base = defaultStateLayoutFs()
    const layout = join(m.sub, 'layout.json')
    const fs: StateLayoutFs = {
      ...base,
      // The custody roster is removed after the journal is examined.
      unlink: async (path) => {
        if (path === m.oldPaths.roster)
          throw Object.assign(new Error('injected'), { code: 'EIO' })
        await base.unlink(path)
      },
      rename: async (from, to) => {
        if (recordWrite === 'fails' && to === layout)
          throw Object.assign(new Error('injected'), { code: 'EIO' })
        await base.rename(from, to)
      },
    }
    const attempt = decide(m, { fs })
    await expect(attempt).rejects.toBeInstanceOf(StateLayoutRefusalError)
    await expect(attempt).rejects.toMatchObject({
      code: 'conflict',
      paths: [moving, m.newPaths.journal],
    })
    expect({
      recordWrite,
      cleanup: (await readStateLayoutRecord(m.sub))?.cleanup,
    }).toEqual({
      recordWrite,
      cleanup: recordWrite === 'succeeds' ? 'conflict' : 'pending',
    })
    if (recordWrite === 'succeeds')
      expect((await readStateLayoutRecord(m.sub))?.conflict).toEqual([
        { old: moving, new: m.newPaths.journal },
      ])
    // Both copies are kept.
    expect(await readFile(moving, 'utf8')).toBe(changed)
    expect(await readFile(m.newPaths.journal, 'utf8')).toBe(
      m.original.journal as string,
    )
    expect(processStateLayout(m.oldPaths.legacyConfig)).toBe(
      LEGACY_STATE_LAYOUT,
    )
    // The next start, with nothing failing, still refuses.
    await expect(decide(m)).rejects.toMatchObject({ code: 'conflict' })
  }
})

test('a process serving with cleanup pending notices a changed set-aside journal', async () => {
  const m = await machine()
  const base = defaultStateLayoutFs()
  const fs: StateLayoutFs = {
    ...base,
    // The first old copy can't be removed, so cleanup stays pending.
    unlink: async (path) => {
      if (path === m.oldPaths.state)
        throw Object.assign(new Error('injected'), { code: 'EIO' })
      await base.unlink(path)
    },
  }
  expect((await decide(m, { fs })).kind).toBe('state-home')
  const record = await readStateLayoutRecord(m.sub)
  expect(record?.cleanup).toBe('pending')
  const moving = `${m.oldPaths.journal}.moving-${record?.attempt}`
  expect(await readFile(moving, 'utf8')).toBe(m.original.journal as string)
  const guard = nativeRelocationGuard(m.newPaths)
  await expect(guard.assertNotRelocated()).resolves.toBeUndefined()
  await appendFile(moving, ' ')
  await expect(guard.assertNotRelocated()).rejects.toMatchObject({
    code: 'conflict',
    paths: [moving, m.newPaths.journal],
  })
  // The verified bytes back again: serving resumes.
  await writeFile(moving, m.original.journal as string)
  await expect(guard.assertNotRelocated()).resolves.toBeUndefined()
})

test('an old pool state or journal reappearing after the move is a fatal conflict at start; a vault file is only a warning', async () => {
  for (const [role, path] of [
    ['pool state', (m: Machine) => m.oldPaths.state],
    ['journal', (m: Machine) => m.oldPaths.journal],
  ] as const) {
    const m = await machine()
    expect((await decide(m)).kind).toBe('state-home')
    await writeFile(path(m), '{"reappeared":true}\n')
    const attempt = decide(m)
    await expect(attempt).rejects.toMatchObject({ code: 'conflict' })
    await expect(attempt).rejects.toThrow(path(m))
    expect({ role, kept: await readFile(path(m), 'utf8') }).toEqual({
      role,
      kept: '{"reappeared":true}\n',
    })
  }
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  const roster = nativeVaultPaths(m.oldPaths, LEGACY_STATE_LAYOUT).roster
  await writeFile(roster, '{"roster":"stale"}\n')
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  expect((await decide(m)).kind).toBe('state-home')
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining(roster),
    }),
  )
})

test('an already serving state-home process warns once, and keeps serving, when an old vault file is back', async () => {
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  const guard = nativeRelocationGuard(m.newPaths)
  await expect(guard.assertNotRelocated()).resolves.toBeUndefined()
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  const roster = nativeVaultPaths(m.oldPaths, LEGACY_STATE_LAYOUT).roster
  await writeFile(roster, '{"roster":"stale"}\n')
  await expect(guard.assertNotRelocated()).resolves.toBeUndefined()
  // A later change to the same file is checked again but not warned again.
  await appendFile(roster, ' ')
  await expect(guard.assertNotRelocated()).resolves.toBeUndefined()
  expect(
    logs.filter(
      (record) => record.level === 'warn' && record.message.includes(roster),
    ),
  ).toHaveLength(1)
})

test('a changed XDG_STATE_HOME after a move refuses and names where the state went', async () => {
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  const otherRoot = join(m.root, 'other-state')
  const attempt = decide(m, { env: { XDG_STATE_HOME: otherRoot } })
  await expect(attempt).rejects.toMatchObject({ code: 'moved-elsewhere' })
  await expect(attempt).rejects.toThrow(m.sub)
  await expect(attempt).rejects.toThrow(
    join(otherRoot, 'cortexkit', 'anthropic-auth'),
  )
  expect(
    await exists(
      join(otherRoot, 'cortexkit', 'anthropic-auth', 'opencode', 'layout.json'),
    ),
  ).toBe(false)
})

test('a start under another XDG_STATE_HOME that waited for the old holder lock while a move committed refuses instead of staying legacy', async () => {
  const m = await machine()
  const otherRoot = join(m.root, 'other-state')
  let paused!: () => void
  const pausedAt = new Promise<void>((resolve) => {
    paused = resolve
  })
  let resume!: () => void
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })
  // The second start holds its own root's layout lock and has read no
  // tombstone and no marker; it stops right before the old holder lock.
  const second = decide(m, {
    env: { XDG_STATE_HOME: otherRoot },
    onStep: async (step) => {
      if (step !== 'old-holders-locking') return
      paused()
      await resumed
    },
  })
  second.catch(() => {})
  await pausedAt
  // Meanwhile the first start, under the usual root, moves the dataset.
  expect((await decide(m)).kind).toBe('state-home')
  // Each start is its own process: forget the first one's decision.
  resetProcessStateLayoutsForTests()
  resume()
  await expect(second).rejects.toMatchObject({ code: 'moved-elsewhere' })
  await expect(second).rejects.toThrow(m.sub)
  expect(processStateLayout(m.oldPaths.legacyConfig)).toBe(LEGACY_STATE_LAYOUT)
  const holders = await readFile(
    join(m.configDir, HOLDER_FILE_NAME),
    'utf8',
  ).catch(() => '{"entries":[]}')
  expect(JSON.parse(holders).entries).not.toContainEqual(
    expect.objectContaining({ kind: 'legacy' }),
  )
})

test('a state-home process whose registration fails refuses and never falls back to legacy', async () => {
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  await writeFile(join(m.sub, HOLDER_FILE_NAME), '{broken')
  await expect(decide(m)).rejects.toBeInstanceOf(HolderRegistrationError)
  expect(processStateLayout(m.oldPaths.legacyConfig)).toBe(LEGACY_STATE_LAYOUT)
  expect(await readFile(join(m.sub, HOLDER_FILE_NAME), 'utf8')).toBe('{broken')
})

test('a layout-lock timeout refuses a move still unfinished, and admits one another process finished while this start waited for the lock', async () => {
  for (const meanwhile of ['nothing', 'cleanup finished'] as const) {
    const m = await machine()
    // A commit whose cleanup is still pending: the start can't admit it
    // without the layout lock, so it waits for that lock.
    await expect(
      decide(m, { onStep: crashAt('committed') }),
    ).rejects.toBeInstanceOf(StateLayoutCrash)
    const layout = join(m.sub, 'layout.json')
    let waited = false
    await withLock(
      layout,
      { name: 'runtime-layout', ttlMs: 10_000, timeoutMs: 1_000, renew: true },
      async () => {
        const result = decide(m, {
          timeouts: { layoutMs: 500, holderMs: 1_000, dataMs: 1_000 },
          onLockEvent: (event) => {
            if (event.name !== 'runtime-layout' || event.type !== 'contended')
              return
            waited = true
            if (meanwhile !== 'cleanup finished') return
            // The lock holder finishes the cleanup while this start waits.
            const record = JSON.parse(readFileSync(layout, 'utf8'))
            const runtimes = [
              m.oldPaths.runtime,
              nativeVaultPaths(m.oldPaths, LEGACY_STATE_LAYOUT).runtime,
            ]
            for (const path of [
              `${m.oldPaths.journal}.moving-${record.attempt}`,
              ...Object.values(oldFiles(m.oldPaths)).filter(
                (file) => !runtimes.includes(file),
              ),
            ])
              rmSync(path, { force: true })
            writeFileSync(
              layout,
              JSON.stringify({ ...record, cleanup: 'done' }),
            )
          },
        })
        if (meanwhile === 'nothing')
          await expect(result).rejects.toMatchObject({ code: 'busy' })
        else expect((await result).kind).toBe('state-home')
      },
    )
    expect({ meanwhile, waited }).toEqual({ meanwhile, waited: true })
  }
})

test('marker problems refuse: another config folder, an unreadable record, a deleted record', async () => {
  const other = await machine()
  await mkdir(other.sub, { recursive: true })
  await writeFile(
    join(other.sub, 'config-dir.json'),
    JSON.stringify({ version: 1, identity: '/somewhere/else' }),
  )
  await expect(decide(other)).rejects.toMatchObject({ code: 'other-dataset' })

  const broken = await machine()
  await mkdir(broken.sub, { recursive: true })
  await writeFile(join(broken.sub, 'layout.json'), '{"version":1,')
  await expect(decide(broken)).rejects.toMatchObject({
    code: 'marker-unreadable',
  })

  const deleted = await machine()
  expect((await decide(deleted)).kind).toBe('state-home')
  await rm(join(deleted.sub, 'layout.json'))
  const before = await readdir(deleted.sub)
  await expect(decide(deleted)).rejects.toMatchObject({
    code: 'marker-unreadable',
  })
  expect(await readdir(deleted.sub)).toEqual(before)
})

/** The state folder's files other than lock files, by name. */
async function subTree(m: Machine) {
  const tree: Record<string, string> = {}
  for (const name of (await readdir(m.sub)).sort())
    if (!name.endsWith('.lock'))
      tree[name] = await readFile(join(m.sub, name), 'utf8')
  return tree
}

test('recovery refuses a record that does not list exactly this dataset, and deletes nothing', async () => {
  type RawRecord = {
    attempt: string
    files: { role: string; to: string }[]
    barriers: { localRuntime: { original: string | null } }
  }
  const cases: [string, (record: RawRecord, victim: string) => void][] = [
    [
      'a missing role',
      (record) => {
        record.files = record.files.filter(
          (file) => file.role !== 'vaultRouting',
        )
      },
    ],
    [
      'a substituted path',
      (record, victim) => {
        const roster = record.files.find((file) => file.role === 'localRoster')
        if (roster) roster.to = victim
      },
    ],
    [
      'an inconsistent barrier',
      (record) => {
        record.barriers.localRuntime.original = null
      },
    ],
    [
      'a malformed attempt id',
      (record) => {
        record.attempt = '../../elsewhere'
      },
    ],
  ]
  for (const [name, edit] of cases) {
    const m = await machine()
    await expect(
      decide(m, { onStep: crashAt('copies-flushed') }),
    ).rejects.toBeInstanceOf(StateLayoutCrash)
    // An unrelated file with the same bytes as a copy the rollback would
    // remove.
    const victim = join(m.root, 'victim.json')
    await writeFile(victim, await readFile(m.newPaths.roster))
    const layout = join(m.sub, 'layout.json')
    const record = JSON.parse(await readFile(layout, 'utf8')) as RawRecord
    edit(record, victim)
    await writeFile(layout, JSON.stringify(record))
    const snapshot = async () => ({
      name,
      old: await oldTree(m),
      sub: await subTree(m),
      victim: await readFile(victim, 'utf8').catch(() => undefined),
    })
    const before = await snapshot()
    await expect(decide(m)).rejects.toMatchObject({
      code: 'marker-unreadable',
    })
    expect(await snapshot()).toEqual(before)
  }
})

test('rollback never removes config-dir.json, holder files, lock files, unknown files or a copy whose source vanished', async () => {
  const m = await machine()
  await expect(
    decide(m, { onStep: crashAt('copies-flushed') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  await writeFile(join(m.sub, 'notes.txt'), 'mine')
  await writeFile(join(m.sub, 'something.lock'), '')
  // The old custody roster disappears: its copy may be the only one left.
  await rm(m.oldPaths.roster)
  await olderVersionRunning(m)
  expect((await decide(m)).kind).toBe('legacy')
  const names = await readdir(m.sub)
  for (const name of [
    'config-dir.json',
    HOLDER_FILE_NAME,
    'notes.txt',
    'something.lock',
    'anthropic-auth-custody-roster.json',
  ])
    expect({ name, kept: names.includes(name) }).toEqual({ name, kept: true })
  expect(await subDataFiles(m)).toEqual(['anthropic-auth-custody-roster.json'])
})

/** Add a row to the old pool's settings file behind every lock, as a racing writer would. */
function addRowBehindLocks(m: Machine, id: string) {
  const config = JSON.parse(readFileSync(m.oldPaths.config, 'utf8'))
  config.accounts.push({ id, type: 'oauth', addedAt: 1 })
  writeFileSync(m.oldPaths.config, JSON.stringify(config))
}

test('a row added while the row locks are taken is retried once, and a second change keeps the legacy layout', async () => {
  for (const changes of [1, Number.POSITIVE_INFINITY]) {
    const m = await machine()
    let added = 0
    const decision = await decide(m, {
      onLockEvent: (event) => {
        if (
          event.type === 'acquiring' &&
          event.name === 'provider-anthropic' &&
          event.path === m.oldPaths.state &&
          added < changes
        ) {
          added++
          addRowBehindLocks(m, `racer-${added}`)
        }
      },
    })
    if (changes === 1) {
      expect(decision.kind).toBe('state-home')
      expect(added).toBe(1)
    } else {
      expect(decision.kind).toBe('legacy')
      expect(added).toBe(2)
      expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
      expect(await subDataFiles(m)).toEqual([])
    }
  }
})

/** A response-header quota reading for account `acct-a`. */
function headerReading(checkedAt: number, usedPercent: number) {
  const window = { usedPercent, remainingPercent: 100 - usedPercent, checkedAt }
  return toNativeQuotaMap({
    accountIdentity: 'acct-a',
    source: 'headers',
    checkedAt,
    five_hour: window,
    seven_day: window,
  } as OAuthQuotaSnapshot)
}

/** Whether the old pool settings hold a reading with `usedPercent`. */
async function settingsHold(m: Machine, usedPercent: number) {
  const text = JSON.stringify(
    JSON.parse(await readFile(m.oldPaths.config, 'utf8')),
  )
  return text.includes(`"usedPercent":${usedPercent}`)
}

test('a move first drains the quota writes this process queued for the dataset, and a failed drain keeps the dataset in place', async () => {
  for (const drain of ['succeeds', 'fails'] as const) {
    const m = await machine({ identity: 'acct-a' })
    const store = createNativePoolStore({
      paths: m.oldPaths,
      quota: nativeQuotaCodec,
    })
    const attribution = { credentialEpoch: 1, identity: 'acct-a' }
    // The first reading is written at once; the next waits for the
    // coalescing interval, so it is still queued when the move starts.
    await store.recordQuota('a', attribution, headerReading(1_000, 11))
    const deadline = Date.now() + 5_000
    while (!(await settingsHold(m, 11)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    expect(await settingsHold(m, 11)).toBe(true)
    await store.recordQuota('a', attribution, headerReading(2_000, 37.5))
    expect(await settingsHold(m, 37.5)).toBe(false)
    const order: string[] = []
    const close = store.close
    store.close = async () => {
      order.push('drained')
      if (drain === 'fails') throw new Error('injected drain failure')
      await close()
    }
    const before = await oldTree(m)
    const decision = await decide(m, {
      onLockEvent: (event) => {
        if (event.type === 'acquiring') order.push(event.name)
      },
    })
    if (drain === 'succeeds') {
      expect(decision.kind).toBe('state-home')
      // The queued reading was committed, under the store locks, before the
      // mover took its first data lock.
      expect(await settingsHold(m, 37.5)).toBe(true)
      expect(order.indexOf('drained')).toBeGreaterThan(-1)
      expect(order.indexOf('drained')).toBeLessThan(
        order.indexOf('native-migration'),
      )
    } else {
      expect(decision.kind).toBe('legacy')
      if (decision.kind === 'legacy')
        expect(decision.reasons.join(' ')).toContain('injected drain failure')
      // Nothing was locked for the move, copied or written.
      expect(order).not.toContain('native-migration')
      expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
      expect(await subDataFiles(m)).toEqual([])
      expect(await oldTree(m)).toEqual(before)
      await close()
    }
  }
})

test('an ordinary explicit start refuses when its registration fails: a malformed holder file, a held holder lock, an unwritable folder', async () => {
  for (const failure of ['malformed', 'lock', 'unwritable'] as const) {
    const m = await machine()
    const dir = join(m.root, 'custom')
    await mkdir(dir)
    const holderFile = join(dir, HOLDER_FILE_NAME)
    const env = {
      ...m.env,
      OPENCODE_ANTHROPIC_AUTH_FILE: join(dir, 'anthropic-auth.json'),
    }
    const start = () =>
      decide(m, {
        env,
        timeouts: { layoutMs: 300, holderMs: 300, dataMs: 300 },
      })
    let result: Promise<StateLayoutDecision>
    if (failure === 'malformed') {
      await writeFile(holderFile, '{not json')
      result = start()
    } else if (failure === 'lock') {
      result = withLock(
        holderFile,
        { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000, renew: true },
        start,
      )
    } else {
      await chmod(dir, 0o500)
      result = start().finally(() => chmod(dir, 0o700))
    }
    await expect(result).rejects.toBeInstanceOf(HolderRegistrationError)
    await expect(result).rejects.toMatchObject({
      code:
        failure === 'malformed'
          ? 'malformed'
          : failure === 'lock'
            ? 'lock-timeout'
            : 'unavailable',
      directory: dir,
    })
  }
})

test('an override into the moved state folder refuses at start', async () => {
  const m = await machine()
  expect((await decide(m)).kind).toBe('state-home')
  const env = {
    ...m.env,
    OPENCODE_ANTHROPIC_AUTH_FILE: join(m.sub, 'anthropic-auth.json'),
  }
  const saved = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  await expect(decide(m, { env })).rejects.toMatchObject({
    code: 'managed-folder',
  })
  expect(process.env.OPENCODE_ANTHROPIC_AUTH_FILE).toBe(saved)
})

/** A home folder whose OpenCode config folder does not exist yet. */
async function missingConfigFolder(): Promise<Machine> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'state-move-')))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  const configDir = join(home, '.config', 'opencode')
  const state = join(root, 'state')
  const oldPaths = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  const sub = join(state, 'cortexkit', 'anthropic-auth', 'opencode')
  return {
    root,
    home,
    configDir,
    env: { XDG_STATE_HOME: state },
    sub,
    oldPaths,
    newPaths: await resolveNativePoolPaths(
      oldPaths.legacyConfig,
      oldPaths.legacyState,
      { kind: 'state-home', dir: sub },
    ),
    artifacts: {
      rpcRoots: [join(root, 'rpc')],
      rpcDirs: [],
      cacheKeepDirs: [join(root, 'cachekeep')],
    },
    original: {},
  }
}

test('a start that found no config folder creates it owner-only, stays legacy, and a second start while it runs moves nothing', async () => {
  const m = await missingConfigFolder()
  const first = await decide(m)
  expect(first).toMatchObject({
    kind: 'legacy',
    reasons: ['the config folder did not exist when this process started'],
  })
  expect((await lstat(m.configDir)).mode & 0o777).toBe(0o700)
  expect(await readdir(m.configDir)).toEqual([HOLDER_FILE_NAME])
  // The first start still runs: its entry keeps the folder where it is.
  const second = await decide(m, { liveness: liveness() })
  expect(second.kind).toBe('legacy')
  expect(await exists(join(m.sub, 'layout.json'))).toBe(false)
  expect(await readdir(m.configDir)).toEqual([HOLDER_FILE_NAME])
  expect(await readRelocationPointer(m.oldPaths.runtime)).toBeUndefined()
})

test('a start that found no config folder and waited for its holder lock while another start moved the new folder serves the move instead of overruling it', async () => {
  const m = await missingConfigFolder()
  let other: StateLayoutDecision | undefined
  const decision = await decide(m, {
    onStep: async (step) => {
      // The folder now exists; another start takes the holder lock first
      // and moves it before this start registers.
      if (step === 'old-holders-locking' && !other) other = await decide(m)
    },
  })
  expect(other?.kind).toBe('state-home')
  expect(decision.kind).toBe('state-home')
  expect(decision.layout).toEqual({ kind: 'state-home', dir: m.sub })
})

/**
 * A filesystem whose `nth` rename onto `layout.json` fails: with `nth` set
 * to the cleanup's record write, cleanup ends with a failure after it found
 * a conflict.
 */
function failingRecordWrite(m: Machine, nth: number): StateLayoutFs {
  const base = defaultStateLayoutFs()
  let writes = 0
  return {
    ...base,
    rename: async (from, to) => {
      if (to === join(m.sub, 'layout.json') && ++writes === nth)
        throw Object.assign(new Error('injected'), { code: 'EIO' })
      await base.rename(from, to)
    },
  }
}

test("cleanup's conflict refusal reaches the moving start even when the serving check alone would admit it", async () => {
  const m = await machine()
  const changed = `${m.original.localPoolState} `
  const attempt = decide(m, {
    // Records: preparing, committed, then the cleanup's.
    fs: failingRecordWrite(m, 3),
    onStep: async (step) => {
      // The old credentials change after the commit, so cleanup finds a
      // conflict; then the changed copy goes away before the admission,
      // so only cleanup's own refusal can stop this start.
      if (step === 'committed') await writeFile(m.oldPaths.state, changed)
      if (step === 'cleanup:vaultRouting') await rm(m.oldPaths.state)
    },
  })
  await expect(attempt).rejects.toMatchObject({ code: 'conflict' })
})

test("cleanup's conflict refusal reaches a start that retries a pending cleanup even when the serving check alone would admit it", async () => {
  const m = await machine()
  await expect(
    decide(m, { onStep: crashAt('committed') }),
  ).rejects.toBeInstanceOf(StateLayoutCrash)
  expect((await readStateLayoutRecord(m.sub))?.cleanup).toBe('pending')
  await writeFile(m.oldPaths.state, `${m.original.localPoolState} `)
  const attempt = decide(m, {
    fs: failingRecordWrite(m, 1),
    onStep: async (step) => {
      if (step === 'cleanup:vaultRouting') await rm(m.oldPaths.state)
    },
  })
  await expect(attempt).rejects.toMatchObject({ code: 'conflict' })
})
