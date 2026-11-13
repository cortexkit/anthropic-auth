import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockPathFor, withLock } from '@cortexkit/common-auth/fs'
import {
  HOLDER_FILE_NAME,
  HOLDER_REGISTRATION_ERROR_MESSAGES,
  type HolderLiveness,
  HolderRegistrationError,
  type NativeHolderRegistration,
  resetNativeHolderRegistryForTests,
  stateRefusalPublicMessage,
} from '../holder-registry.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import {
  checkStateHomeServing,
  createStateHomeServingGuard,
  resetStateHomeServingGuardForTests,
  stateHomeServingFiles,
} from '../state-home-serving-guard.ts'
import {
  type DecideStateLayoutOptions,
  decideOpenCodeStateLayout,
  decidePiStateLayout,
} from '../state-layout-decision.ts'
import {
  StateLayoutRefusalError,
  stateLayoutRefusalPublicMessage,
} from '../state-layout-errors.ts'
import { defaultStateLayoutFs, type StateLayoutFs } from '../state-layout-io.ts'
import { relocationTombstone, StateLayoutCrash } from '../state-layout-move.ts'
import {
  LEGACY_STATE_LAYOUT,
  resetProcessStateLayoutsForTests,
} from '../state-layout-paths.ts'
import { readStateLayoutRecord } from '../state-layout-record.ts'
import { restoreLegacyLayout } from '../state-layout-restore.ts'

const roots: string[] = []
const closers: NativeHolderRegistration[] = []

beforeEach(() => {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  resetStateHomeServingGuardForTests()
})

/** Undo a test's induced failures before its folders are removed. */
const repairs: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const repair of repairs.splice(0)) await repair()
  __setLogTestSink(null)
  for (const registration of closers.splice(0)) registration.close()
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

/** Every pid is alive unless listed as dead. */
function liveness(dead: number[] = []): HolderLiveness {
  return {
    pidAlive: (pid) => !dead.includes(pid),
    incarnation: async () => null,
  }
}

/**
 * A home folder with OpenCode's config folder and a state root beside it.
 * The config folder holds only a local runtime file, so an ordinary
 * registration there has a dataset file to register beside.
 */
async function machine() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'state-move-off-')))
  roots.push(root)
  const home = join(root, 'home')
  const configDir = join(home, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  const stateRoot = join(root, 'state')
  const legacy = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  await writeFile(legacy.runtime, '{"version":1}\n', { mode: 0o600 })
  return {
    root,
    home,
    configDir,
    stateRoot,
    legacy,
    env: { XDG_STATE_HOME: stateRoot } as NodeJS.ProcessEnv,
  }
}

type Machine = Awaited<ReturnType<typeof machine>>

function decide(m: Machine, options: Partial<DecideStateLayoutOptions> = {}) {
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
  return decideOpenCodeStateLayout({
    role: 'opencode2',
    env: m.env,
    home: m.home,
    artifacts: {
      rpcRoots: [join(m.root, 'rpc')],
      rpcDirs: [],
      cacheKeepDirs: [join(m.root, 'cachekeep')],
    },
    liveness: liveness([process.pid]),
    timeouts: { layoutMs: 300, holderMs: 300, dataMs: 300 },
    ...options,
  })
}

for (const override of [
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_TUI_PREFERENCES_FILE',
] as const)
  for (const moveEnabled of [false, true])
    test(`a successful legacy override registration is observable with ${override} and moving ${moveEnabled}`, async () => {
      const m = await machine()
      const decision = await decide(m, {
        env: { ...m.env, [override]: join(m.root, 'override.json') },
        moveEnabled,
      })
      expect(decision.kind).toBe('legacy')
      expect(decision.layout).toEqual(LEGACY_STATE_LAYOUT)
      if (decision.kind !== 'legacy') throw new Error('not expected')
      expect(decision.registration?.status).toBe('registered')
      await decision.registration?.settled
      decision.registration?.close()
      const holders = JSON.parse(
        await readFile(join(m.configDir, HOLDER_FILE_NAME), 'utf8'),
      ) as { entries: { pid: number; kind: string }[] }
      expect(holders.entries).toContainEqual(
        expect.objectContaining({ pid: process.pid, kind: 'legacy' }),
      )
    })

type Kind = 'legacy' | 'explicit' | 'pi'
type Failure = 'malformed' | 'write' | 'lock'

/** Between background retries of a failed registration, in these tests. */
const RETRY_MS = 25

/** Poll `condition` until it holds, failing after a few seconds. */
async function until(condition: () => boolean | Promise<boolean>) {
  // Inside bun's 5-second test timeout, so a miss fails with this message.
  const deadline = Date.now() + 2_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('the condition never held')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Start a process of `kind` whose registration fails by `failure`, and
 * return what the start resolved to (or the refusal it threw). The failure
 * lasts until `repair` is called, so background retries keep failing until
 * then. Legacy with moving on stays legacy through a routing override, the
 * case where moving on still keeps OpenCode's own dataset in its config
 * folder.
 */
async function startWithFailedRegistration(
  kind: Kind,
  failure: Failure,
  moveEnabled: boolean,
) {
  const m = await machine()
  let dir = m.configDir
  let env = m.env
  let piPaths: Awaited<ReturnType<typeof resolveNativePoolPaths>> | undefined
  if (kind === 'legacy' && moveEnabled)
    env = {
      ...env,
      OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(m.root, 'routing.json'),
    }
  if (kind === 'explicit') {
    dir = join(m.root, 'custom')
    await mkdir(dir)
    env = {
      ...env,
      OPENCODE_ANTHROPIC_AUTH_FILE: join(dir, 'anthropic-auth.json'),
    }
    const paths = await resolveNativePoolPaths(
      join(dir, 'anthropic-auth.json'),
      join(dir, 'anthropic-auth-state.json'),
      LEGACY_STATE_LAYOUT,
    )
    await writeFile(paths.runtime, '{"version":1}\n', { mode: 0o600 })
  }
  if (kind === 'pi') {
    dir = join(m.root, 'agent')
    await mkdir(dir)
    piPaths = await resolveNativePoolPaths(
      join(dir, 'anthropic-auth.json'),
      undefined,
      LEGACY_STATE_LAYOUT,
    )
    await writeFile(piPaths.runtime, '{"version":1}\n', { mode: 0o600 })
  }
  const holderFile = join(dir, HOLDER_FILE_NAME)
  const events: NativeLockEvent[] = []
  let failing = true
  // A failed holder write: the folder turns read-only once the holder lock
  // is held, so the lock is taken but the holder file can't be written.
  const onLockEvent = (event: NativeLockEvent) => {
    events.push(event)
    if (
      failing &&
      failure === 'write' &&
      event.type === 'acquired' &&
      event.name === 'holders' &&
      event.path === holderFile
    )
      chmodSync(dir, 0o500)
  }
  if (failure === 'malformed') await writeFile(holderFile, '{not json')
  // Another process holds the holder lock until the repair.
  let releaseLock = () => {}
  let holding: Promise<unknown> = Promise.resolve()
  if (failure === 'lock') {
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    let taken = () => {}
    const isTaken = new Promise<void>((resolve) => {
      taken = resolve
    })
    holding = withLock(
      holderFile,
      { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000, renew: true },
      async () => {
        taken()
        await held
      },
    )
    await isTaken
  }
  const repair = async () => {
    failing = false
    releaseLock()
    await holding
    await chmod(dir, 0o700)
    if (failure === 'malformed') await rm(holderFile, { force: true })
    // A holder lock taken while the folder was read-only could not be
    // removed on release; it would block every retry until it expires.
    if (failure === 'write')
      await rm(lockPathFor(holderFile, 'holders'), {
        recursive: true,
        force: true,
      })
  }
  repairs.push(repair)
  const start = async (): Promise<NativeHolderRegistration | undefined> => {
    if (kind === 'pi' && piPaths)
      return (
        await decidePiStateLayout({
          paths: piPaths,
          role: 'pi',
          onLockEvent,
          liveness: liveness([process.pid]),
          lockTimeoutMs: 300,
          retryIntervalMs: RETRY_MS,
          moveEnabled,
        })
      ).registration
    const decision = await decide(m, {
      env,
      onLockEvent,
      moveEnabled,
      timeouts: {
        layoutMs: 300,
        holderMs: 300,
        dataMs: 300,
        retryMs: RETRY_MS,
      },
    })
    expect(decision.kind).toBe(kind as 'legacy' | 'explicit')
    if (decision.kind === 'state-home') throw new Error('not expected')
    return decision.registration
  }
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  const outcome = await start().then(
    (registration) => ({ registration }),
    (error: unknown) => ({ error }),
  )
  // The start's own write failure leaves the folder read-only; the retries
  // turn it read-only again each time they take the lock, until the repair.
  await chmod(dir, 0o700)
  if ('registration' in outcome && outcome.registration)
    closers.push(outcome.registration)
  return {
    m,
    dir,
    holderFile,
    outcome,
    events,
    repair,
    warnings: () =>
      logs.filter(
        (record) =>
          record.level === 'warn' &&
          record.message.includes('could not record that it is using'),
      ),
  }
}

/** The lock events of background retries on `holderFile` of `type`. */
function retryEvents(
  events: readonly NativeLockEvent[],
  holderFile: string,
  type: NativeLockEvent['type'],
) {
  return events.filter(
    (event) =>
      event.detached === true &&
      event.name === 'holders' &&
      event.path === holderFile &&
      event.type === type,
  )
}

async function holderEntries(holderFile: string) {
  const text = await readFile(holderFile, 'utf8').catch(() => undefined)
  try {
    return (
      JSON.parse(text ?? '') as { entries: { pid: number; kind: string }[] }
    ).entries
  } catch {
    // Absent or invalid: nobody is registered there.
    return []
  }
}

for (const kind of ['legacy', 'explicit', 'pi'] as const)
  for (const failure of ['malformed', 'write', 'lock'] as const) {
    test(`moving off: a ${kind} start whose registration fails (${failure}) still serves, warns once, and its background retry registers it once repaired`, async () => {
      const { outcome, events, holderFile, repair, warnings } =
        await startWithFailedRegistration(kind, failure, false)
      if ('error' in outcome) throw outcome.error
      const registration = outcome.registration
      if (!registration) throw new Error('the start registered at once')
      expect(registration.status).toBe('pending')
      expect(warnings()).toHaveLength(1)
      // Retries run, in the background, and keep failing while the failure
      // lasts.
      await until(
        () => retryEvents(events, holderFile, 'acquiring').length >= 2,
      )
      expect(await holderEntries(holderFile)).not.toContainEqual(
        expect.objectContaining({ pid: process.pid }),
      )
      await repair()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        registration.settled,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('the retry never registered')),
            2_000,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      expect(await holderEntries(holderFile)).toContainEqual(
        expect.objectContaining({ pid: process.pid, kind }),
      )
      // The registration that landed was a background retry's.
      expect(
        retryEvents(events, holderFile, 'acquired').length,
      ).toBeGreaterThan(0)
      // The failed retries did not warn again.
      expect(warnings()).toHaveLength(1)
    })

    test(`moving on: a ${kind} start whose registration fails (${failure}) refuses`, async () => {
      const { outcome, dir, repair } = await startWithFailedRegistration(
        kind,
        failure,
        true,
      )
      await repair()
      if (!('error' in outcome)) throw new Error('the start was admitted')
      if (kind === 'legacy' && failure === 'lock') {
        // OpenCode's own dataset waits for the holder lock as part of the
        // layout decision, which reports a lock held too long as busy.
        expect(outcome.error).toBeInstanceOf(StateLayoutRefusalError)
        expect(outcome.error).toMatchObject({ code: 'busy' })
        return
      }
      expect(outcome.error).toBeInstanceOf(HolderRegistrationError)
      expect(outcome.error).toMatchObject({
        code:
          failure === 'malformed'
            ? 'malformed'
            : failure === 'lock'
              ? 'lock-timeout'
              : 'unavailable',
        directory: dir,
      })
    })
  }

/** The state-home folder of the machine's config folder. */
function stateSub(m: Machine) {
  return join(m.stateRoot, 'cortexkit', 'anthropic-auth', 'opencode')
}

/** A relocation tombstone over the legacy local runtime, as a move leaves it. */
async function tombstone(m: Machine) {
  await writeFile(
    m.legacy.runtime,
    relocationTombstone({
      sub: stateSub(m),
      stateRoot: join(m.stateRoot, 'cortexkit', 'anthropic-auth'),
      identity: m.configDir,
      attempt: '00000000-0000-4000-8000-000000000000',
      by: 'test',
    }),
  )
}

/** What a start shows a person for a refusal: the fixed text, naming no file. */
function expectFixedRefusal(error: unknown, m: Machine) {
  expect(error).toBeInstanceOf(StateLayoutRefusalError)
  expect(error).toMatchObject({ code: 'marker-unreadable' })
  const shown = stateRefusalPublicMessage(error)
  expect(shown).toBe(stateLayoutRefusalPublicMessage('marker-unreadable'))
  expect(shown).not.toContain(m.root)
}

test('moving off: a state root that is not a folder, or that the process may not read, does not stop a legacy start', async () => {
  for (const kind of ['not-a-folder', 'unreadable'] as const) {
    const m = await machine()
    if (kind === 'not-a-folder') {
      await writeFile(m.stateRoot, 'a file where the state root would be')
    } else {
      await mkdir(stateSub(m), { recursive: true })
      await chmod(m.stateRoot, 0o000)
    }
    try {
      const decision = await decide(m, { moveEnabled: false })
      expect(decision.kind).toBe('legacy')
      expect(decision.layout).toEqual(LEGACY_STATE_LAYOUT)
    } finally {
      if (kind === 'unreadable') await chmod(m.stateRoot, 0o700)
    }
  }
})

test('moving off: a corrupt layout.json in the state folder with no tombstone in the config folder does not stop a legacy start', async () => {
  const m = await machine()
  await mkdir(stateSub(m), { recursive: true })
  await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
  await writeFile(join(stateSub(m), 'config-dir.json'), '{ not json either')
  const decision = await decide(m, { moveEnabled: false })
  expect(decision.kind).toBe('legacy')
  // Nothing in the state folder was read or changed.
  expect(await readFile(join(stateSub(m), 'layout.json'), 'utf8')).toBe(
    '{ not json',
  )
})

test('a tombstone in the config folder keeps the strict checks: an unreadable state folder or record refuses with the fixed text', async () => {
  for (const moveEnabled of [false, true])
    for (const kind of [
      'state-root-not-a-folder',
      'config-dir-marker-unreadable',
      'layout-corrupt',
    ] as const) {
      const m = await machine()
      await tombstone(m)
      if (kind === 'state-root-not-a-folder')
        await writeFile(m.stateRoot, 'a file where the state root would be')
      else await mkdir(stateSub(m), { recursive: true })
      if (kind === 'config-dir-marker-unreadable')
        await mkdir(join(stateSub(m), 'config-dir.json'))
      if (kind === 'layout-corrupt')
        await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
      const error = await decide(m, { moveEnabled }).then(
        () => undefined,
        (caught: unknown) => caught,
      )
      expectFixedRefusal(error, m)
    }
})

test('moving off: a journal a move set aside keeps the strict checks', async () => {
  const m = await machine()
  await writeFile(
    `${m.legacy.journal}.moving-00000000-0000-4000-8000-000000000000`,
    '{}\n',
  )
  await mkdir(stateSub(m), { recursive: true })
  await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
  const error = await decide(m, { moveEnabled: false }).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expectFixedRefusal(error, m)
})

/** A host's view of a refusal: the fixed text, naming no file or folder. */
function expectFixedRegistrationRefusal(error: unknown, m: Machine) {
  expect(error).toBeInstanceOf(HolderRegistrationError)
  expect(error).toMatchObject({ code: 'unavailable' })
  const shown = stateRefusalPublicMessage(error)
  expect(shown).toBe((error as Error).message)
  expect(HOLDER_REGISTRATION_ERROR_MESSAGES).toContain(shown as string)
  expect(shown).not.toContain(m.root)
}

for (const branch of ['override', 'layout-lock', 'state-home'] as const)
  test(`a holder lock that fails with an I/O error, not contention, refuses with the fixed registration text once moving is on, and serves with moving off when no move is in sight (${branch})`, async () => {
    for (const moveEnabled of [false, true]) {
      const m = await machine()
      const env =
        branch === 'override'
          ? {
              ...m.env,
              OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: join(
                m.root,
                'routing.json',
              ),
            }
          : m.env
      if (branch === 'state-home') {
        // A moved dataset, admitted through the state folder's holder lock.
        expect((await decide(m, { moveEnabled: true })).kind).toBe('state-home')
      }
      // The folder whose holder lock is taken can't take new files, so the
      // lock file can't be created (EACCES).
      const locked = branch === 'state-home' ? stateSub(m) : m.configDir
      await chmod(locked, 0o500)
      const result = await decide(m, { env, moveEnabled }).then(
        (decision) => ({ decision }),
        (error: unknown) => ({ error }),
      )
      await chmod(locked, 0o700)
      if ('decision' in result && result.decision.kind !== 'state-home') {
        const registration = result.decision.registration
        if (registration) closers.push(registration)
      }
      if (branch === 'layout-lock' && !moveEnabled) {
        // Moving off with no move in sight never takes the state folder's
        // locks: a legacy start serves, its registration retried later.
        if ('error' in result) throw result.error
        expect(result.decision.kind).toBe('legacy')
        continue
      }
      if (branch === 'override' && !moveEnabled) {
        if ('error' in result) throw result.error
        expect(result.decision.kind).toBe('legacy')
        continue
      }
      if (!('error' in result)) throw new Error('the start was admitted')
      expectFixedRegistrationRefusal(result.error, m)
    }
  })

/**
 * A machine whose OpenCode uses its own config folder (OPENCODE_CONFIG_DIR),
 * while the home directory's default config folder can't be resolved: a
 * folder on its way may not be searched, or it is a symlink loop. Returns
 * the machine and a function that makes the default folder resolvable
 * again, so the test can clean up.
 */
async function customConfigMachine(homeDefault: 'inaccessible' | 'looping') {
  const m = await machine()
  const configDir = join(m.root, 'custom-config')
  await mkdir(configDir)
  const legacy = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  await writeFile(legacy.runtime, '{"version":1}\n', { mode: 0o600 })
  const dotConfig = join(m.home, '.config')
  if (homeDefault === 'looping') {
    await rm(m.configDir, { recursive: true })
    await symlink(m.configDir, m.configDir)
  } else await chmod(dotConfig, 0o000)
  const custom: Machine = {
    ...m,
    configDir,
    legacy,
    env: { ...m.env, OPENCODE_CONFIG_DIR: configDir },
  }
  return { m: custom, repair: () => chmod(dotConfig, 0o700) }
}

for (const homeDefault of ['inaccessible', 'looping'] as const)
  test(`moving off: a custom config folder is served when the home directory's default config folder is ${homeDefault}`, async () => {
    const { m, repair } = await customConfigMachine(homeDefault)
    try {
      const decision = await decide(m, { moveEnabled: false })
      expect(decision.kind).toBe('legacy')
      expect(decision.layout).toEqual(LEGACY_STATE_LAYOUT)
      if (decision.kind !== 'legacy') throw new Error('not expected')
      // Registered beside the custom folder's files, not deferred.
      expect(decision.registration?.status).toBe('registered')
      const holders = JSON.parse(
        await readFile(join(m.configDir, HOLDER_FILE_NAME), 'utf8'),
      ) as { entries: { pid: number; kind: string }[] }
      expect(holders.entries).toContainEqual(
        expect.objectContaining({ pid: process.pid, kind: 'legacy' }),
      )
    } finally {
      await repair()
    }
  })

for (const homeDefault of ['inaccessible', 'looping'] as const)
  test(`once the state folder matters, a home default config folder that is ${homeDefault} refuses with the fixed text`, async () => {
    for (const moveEnabled of [false, true]) {
      const { m, repair } = await customConfigMachine(homeDefault)
      try {
        // With moving off, a tombstone in the config folder sends the start
        // to the full decision, which must name the state folder.
        if (!moveEnabled)
          await writeFile(
            m.legacy.runtime,
            relocationTombstone({
              sub: join(m.root, 'elsewhere'),
              stateRoot: join(m.stateRoot, 'cortexkit', 'anthropic-auth'),
              identity: m.configDir,
              attempt: '00000000-0000-4000-8000-000000000000',
              by: 'test',
            }),
          )
        const error = await decide(m, { moveEnabled }).then(
          () => undefined,
          (caught: unknown) => caught,
        )
        expect(error).toBeInstanceOf(StateLayoutRefusalError)
        expect(error).toMatchObject({ code: 'io-failed' })
        const shown = stateRefusalPublicMessage(error)
        expect(shown).toBe(stateLayoutRefusalPublicMessage('io-failed'))
        expect(shown).not.toContain(m.root)
      } finally {
        await repair()
      }
    }
  })

/** A refusal as a host shows it: the fixed text of `io-failed`, naming no file. */
function expectIoRefusal(error: unknown, m: Machine) {
  expect(error).toBeInstanceOf(StateLayoutRefusalError)
  expect(error).toMatchObject({ code: 'io-failed' })
  const shown = stateRefusalPublicMessage(error)
  expect(shown).toBe(stateLayoutRefusalPublicMessage('io-failed'))
  expect(shown).not.toContain(m.root)
}

/**
 * A move that stopped after its local tombstone was installed: the config
 * folder shows the move and the state folder holds a `preparing` record,
 * which only the layout lock may roll back.
 */
async function interruptedMove(m: Machine) {
  await decide(m, {
    moveEnabled: true,
    onStep: (step) => {
      if (step === 'local-runtime-tombstoned') throw new StateLayoutCrash(step)
    },
  }).catch((error: unknown) => {
    if (!(error instanceof StateLayoutCrash)) throw error
  })
  expect((await readStateLayoutRecord(stateSub(m)))?.phase).toBe('preparing')
}

test('a layout lock that fails with an I/O error, not contention, refuses with the fixed text, moving off or on', async () => {
  for (const moveEnabled of [false, true]) {
    const m = await machine()
    await interruptedMove(m)
    // The state folder can't take new files, so the layout lock file can't
    // be created (EACCES).
    await chmod(stateSub(m), 0o500)
    const error = await decide(m, { moveEnabled }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    await chmod(stateSub(m), 0o700)
    expectIoRefusal(error, m)
    // Nothing was rolled back without the lock.
    expect((await readStateLayoutRecord(stateSub(m)))?.phase).toBe('preparing')
  }
})

test('a state folder that is created but can not be flushed refuses with the fixed text', async () => {
  const m = await machine()
  const base = defaultStateLayoutFs()
  const fs: StateLayoutFs = {
    ...base,
    syncDirectory: async () => {
      throw Object.assign(new Error(`EIO: i/o error, fsync '${m.stateRoot}'`), {
        code: 'EIO',
      })
    },
  }
  const error = await decide(m, { moveEnabled: true, fs }).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expectIoRefusal(error, m)
})

test('a restore whose layout lock fails with an I/O error refuses with the fixed text', async () => {
  const m = await machine()
  expect((await decide(m, { moveEnabled: true })).kind).toBe('state-home')
  await chmod(stateSub(m), 0o500)
  const error = await restoreLegacyLayout({
    env: m.env,
    home: m.home,
    liveness: liveness([process.pid]),
    timeouts: { layoutMs: 300, holderMs: 300, dataMs: 300 },
  }).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  await chmod(stateSub(m), 0o700)
  expectIoRefusal(error, m)
})

test("a serving guard that can't look at the old folder refuses with the fixed text, and looks again next time", async () => {
  const m = await machine()
  const decision = await decide(m, { moveEnabled: true })
  if (decision.kind !== 'state-home') throw new Error('not moved')
  const files = stateHomeServingFiles(decision.dataset.newPaths)
  const guard = createStateHomeServingGuard(files)
  expect(await guard.check()).toBeUndefined()
  // The old copies can't be looked at (EACCES on lstat).
  await chmod(m.configDir, 0o000)
  const refusal = await guard.check()
  const direct = await checkStateHomeServing(files)
  await chmod(m.configDir, 0o700)
  expectIoRefusal(refusal, m)
  expectIoRefusal(direct, m)
  expect(await guard.check()).toBeUndefined()
})

/** The state folder's record can't be parsed, so any strict start refuses. */
async function corruptRecord(m: Machine) {
  await mkdir(stateSub(m), { recursive: true })
  await writeFile(join(stateSub(m), 'layout.json'), '{ not json')
}

test('moving off: a leftover that only looks like a set-aside journal does not stop a legacy start', async () => {
  for (const suffix of [
    'backup',
    '00000000-0000-4000-8000-000000000000.bak',
    '00000000-0000-4000-8000-00000000000',
  ]) {
    const m = await machine()
    await writeFile(`${m.legacy.journal}.moving-${suffix}`, '{}\n')
    await corruptRecord(m)
    const decision = await decide(m, { moveEnabled: false })
    expect({ suffix, kind: decision.kind }).toEqual({ suffix, kind: 'legacy' })
  }
})

/**
 * Make the config folder searchable and writable but not listable, as a
 * person may: every file in it can still be opened by name, so 2.4.x serves
 * it. Returns a function that makes it listable again.
 */
async function unlistable(m: Machine) {
  await chmod(m.configDir, 0o300)
  return () => chmod(m.configDir, 0o700)
}

test('moving off: a config folder that can be searched but not listed serves legacy, journal-less vault-only datasets included', async () => {
  for (const dataset of ['local', 'vault-only'] as const) {
    const m = await machine()
    if (dataset === 'vault-only') {
      // Only the vault runtime: no local runtime and no journal.
      await rm(m.legacy.runtime)
      await writeFile(
        join(m.configDir, 'anthropic-auth-vault-state.json'),
        '{"version":1}\n',
        { mode: 0o600 },
      )
    }
    await corruptRecord(m)
    for (const listable of [true, false]) {
      const repair = listable ? async () => {} : await unlistable(m)
      try {
        const decision = await decide(m, { moveEnabled: false })
        expect({ dataset, listable, kind: decision.kind }).toEqual({
          dataset,
          listable,
          kind: 'legacy',
        })
        if (decision.kind === 'legacy' && decision.registration)
          closers.push(decision.registration)
      } finally {
        await repair()
      }
    }
  }
})

test('moving off: a journal a move set aside keeps the strict checks when the config folder can not be listed', async () => {
  const m = await machine()
  // A move that stopped right after setting the journal aside: a preparing
  // record that says so, the set-aside journal, and no tombstone yet.
  await decide(m, {
    moveEnabled: true,
    onStep: (step) => {
      if (step === 'journal-set-aside') throw new StateLayoutCrash(step)
    },
  }).catch((error: unknown) => {
    if (!(error instanceof StateLayoutCrash)) throw error
  })
  const layout = join(stateSub(m), 'layout.json')
  const record = JSON.parse(await readFile(layout, 'utf8'))
  expect(record.phase).toBe('preparing')
  // This machine has no journal to set aside; record one as a move with a
  // journal does.
  record.barriers.journal = 'present'
  for (const file of record.files)
    if (file.role === 'journal') file.sha256 = 'a'.repeat(64)
  await writeFile(layout, JSON.stringify(record))
  await writeFile(`${m.legacy.journal}.moving-${record.attempt}`, '{}\n')
  // The state folder's other marker can't be read, so the strict checks
  // refuse; serving legacy would mean they never ran.
  await rm(join(stateSub(m), 'config-dir.json'))
  await mkdir(join(stateSub(m), 'config-dir.json'))
  const repair = await unlistable(m)
  const error = await decide(m, { moveEnabled: false }).then(
    () => undefined,
    (caught: unknown) => caught,
  )
  await repair()
  expectFixedRefusal(error, m)
})

test('a config folder that does not exist and can not be created: moving off serves legacy with the registration retried, moving on refuses with the fixed text', async () => {
  for (const moveEnabled of [false, true]) {
    const m = await machine()
    // OPENCODE_CONFIG_DIR names a folder inside one that takes no new files.
    const parent = join(m.root, 'read-only')
    await mkdir(parent)
    const configDir = join(parent, 'opencode')
    await chmod(parent, 0o500)
    repairs.push(() => chmod(parent, 0o700))
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))
    const result = await decide(m, {
      env: { ...m.env, OPENCODE_CONFIG_DIR: configDir },
      moveEnabled,
    }).then(
      (decision) => ({ decision }),
      (error: unknown) => ({ error }),
    )
    if (!moveEnabled) {
      if ('error' in result) throw result.error
      expect(result.decision.kind).toBe('legacy')
      expect(result.decision.layout).toEqual(LEGACY_STATE_LAYOUT)
      if (result.decision.kind !== 'legacy') throw new Error('not expected')
      const registration = result.decision.registration
      if (registration) closers.push(registration)
      expect(registration?.status).toBe('pending')
      expect(
        logs.filter(
          (record) =>
            record.level === 'warn' &&
            record.message.includes('could not record that it is using'),
        ),
      ).toHaveLength(1)
      continue
    }
    if (!('error' in result)) throw new Error('the start was admitted')
    expectFixedRegistrationRefusal(result.error, m)
  }
})

test('moving off: a move that commits while a start waits for the holder lock is found once the lock is taken', async () => {
  const m = await machine()
  const holderFile = join(m.configDir, HOLDER_FILE_NAME)
  let contended = () => {}
  const waiting = new Promise<void>((resolve) => {
    contended = resolve
  })
  let start: Promise<unknown> | undefined
  // Another process (a mover) holds the config folder's holder lock while
  // this start waits for it, and leaves a tombstone before letting go. The
  // record of the move can't be read, so a start that sees the move refuses.
  await withLock(
    holderFile,
    { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000, renew: true },
    async () => {
      start = decide(m, {
        moveEnabled: false,
        timeouts: { layoutMs: 300, holderMs: 5_000, dataMs: 300 },
        onLockEvent: (event) => {
          if (event.type === 'contended' && event.path === holderFile)
            contended()
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      await waiting
      await tombstone(m)
      await corruptRecord(m)
    },
  )
  expectFixedRefusal(await start, m)
  // Nothing was registered in the config folder as a legacy start.
  expect(await holderEntries(holderFile)).not.toContainEqual(
    expect.objectContaining({ pid: process.pid }),
  )
})
