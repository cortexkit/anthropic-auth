import { expect } from 'bun:test'
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
import { withLock } from '@cortexkit/common-auth/fs'

import {
  HOLDER_FILE_NAME,
  type HolderLiveness,
  HolderRegistrationError,
  holderEntryIsLive,
  isDestinationShapedDirectory,
  nativeHolderDatasetFiles,
  openCodeHolderKind,
  processIncarnation,
  type RegisterNativePoolHolderOptions,
  registerNativePoolHolder,
  resetNativeHolderRegistryForTests,
} from '../holder-registry.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import type { OwnerOnlyOptions } from '../owner-only.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { RelocatedError } from '../relocation-guard.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()

async function folder(...segments: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holder-registry-')))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, ...segments)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * A dataset in `dir`. An ordinary process records itself only once one of
 * its files exists, so the pool state file is created unless `empty`.
 */
async function dataset(dir: string, empty = false): Promise<NativePoolPaths> {
  resetNativeHolderRegistryForTests()
  deferCleanup(() => resetNativeHolderRegistryForTests())
  const paths = await resolveNativePoolPaths(
    join(dir, 'anthropic-auth.json'),
    join(dir, 'anthropic-auth-state.json'),
  )
  if (!empty) await writeFile(paths.state, '{}', { mode: 0o600 })
  return paths
}

/** Every pid alive, each with a fixed incarnation, unless the test says otherwise. */
function liveness(
  overrides: {
    dead?: number[]
    incarnations?: Record<number, string | null>
  } = {},
): HolderLiveness {
  return {
    pidAlive: (pid) => !overrides.dead?.includes(pid),
    incarnation: async (pid) =>
      overrides.incarnations && pid in overrides.incarnations
        ? (overrides.incarnations[pid] ?? null)
        : `incarnation-${pid}`,
  }
}

function register(
  paths: NativePoolPaths,
  options: Partial<RegisterNativePoolHolderOptions> = {},
) {
  return registerNativePoolHolder({
    paths,
    role: 'opencode1',
    kind: 'legacy',
    liveness: liveness(),
    ...options,
  })
}

async function holders(dir: string) {
  return JSON.parse(await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')) as {
    version: number
    entries: Array<Record<string, unknown>>
  }
}

function recordLocks() {
  const events: NativeLockEvent[] = []
  return { events, onLockEvent: (event: NativeLockEvent) => events.push(event) }
}

function captureLogs() {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => __setLogTestSink(null))
  return records
}

async function tombstone(path: string) {
  await writeFile(
    path,
    JSON.stringify({
      version: 0,
      relocatedTo: '/state/cortexkit/anthropic-auth/opencode',
      stateRoot: '/state/cortexkit/anthropic-auth',
      identity: '/config/opencode',
      attempt: 'attempt-1',
      by: '2.4.0',
    }),
    { mode: 0o600 },
  )
}

test('a first registration lists this process beside its files and leaves only the holder file behind', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  const before = (await readdir(dir)).sort()
  const locks = recordLocks()

  const result = await register(paths, { onLockEvent: locks.onLockEvent })

  expect(result.status).toBe('registered')
  // The holder lock and its eviction folder are gone again; only the holder
  // file is new in the watched folder.
  expect((await readdir(dir)).sort()).toEqual(
    [...before, HOLDER_FILE_NAME].sort(),
  )
  const file = await holders(dir)
  expect(file.version).toBe(1)
  expect(file.entries).toHaveLength(1)
  expect(file.entries[0]).toMatchObject({
    pid: process.pid,
    incarnation: `incarnation-${process.pid}`,
    role: 'opencode1',
    kind: 'legacy',
    identity: dir,
    files: nativeHolderDatasetFiles(paths),
  })
  expect(nativeHolderDatasetFiles(paths)).toHaveLength(8)
  // Only the holder lock is taken, and no data lock.
  expect(new Set(locks.events.map((event) => event.name))).toEqual(
    new Set(['holders']),
  )
  expect(locks.events.map((event) => event.type)).toEqual([
    'acquiring',
    'acquired',
    'released',
  ])
})

test('a re-initialisation in the same process takes no lock and creates nothing', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  await register(paths)
  const listing = (await readdir(dir)).sort()
  const content = await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')
  const locks = recordLocks()

  const again = await register(paths, { onLockEvent: locks.onLockEvent })

  expect(again.status).toBe('registered')
  expect(locks.events).toEqual([])
  expect((await readdir(dir)).sort()).toEqual(listing)
  expect(await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')).toBe(content)
})

test('a second copy of the code in the same process adds its entry without removing the first', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  await register(paths, { role: 'opencode1' })
  // A second bundle has no memory of the first one's publication.
  resetNativeHolderRegistryForTests()
  await register(paths, { role: 'cli' })
  const roles = (await holders(dir)).entries.map((entry) => entry.role)
  expect(roles.sort()).toEqual(['cli', 'opencode1'])

  // The same registration from yet another copy finds its live entry and
  // writes nothing.
  resetNativeHolderRegistryForTests()
  const content = await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')
  await register(paths, { role: 'cli' })
  expect(await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')).toBe(content)
})

test('the next write prunes dead and reused pids but never a live entry', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  const entry = (pid: number, incarnation: string | null) => ({
    pid,
    incarnation,
    instance: `instance-${pid}`,
    role: 'opencode2',
    release: '2.3.0',
    kind: 'legacy',
    identity: dir,
    files: nativeHolderDatasetFiles(paths),
    registeredAt: Date.now(),
  })
  await writeFile(
    join(dir, HOLDER_FILE_NAME),
    JSON.stringify({
      version: 1,
      entries: [
        entry(910001, 'incarnation-910001'), // dead
        entry(910002, 'started-earlier'), // pid reused by a newer process
        entry(910003, 'incarnation-910003'), // unreadable incarnation now
        entry(910004, 'incarnation-910004'), // live, same incarnation
        entry(910005, null), // live, no incarnation recorded
        { note: 'an entry this version cannot read' },
      ],
    }),
  )

  await register(paths, {
    liveness: liveness({
      dead: [910001],
      incarnations: { 910003: null },
    }),
  })

  const pids = (await holders(dir)).entries.map((value) => value.pid)
  expect(pids).toEqual([910003, 910004, 910005, undefined, process.pid])
})

test('the next locked write removes pre-boot own entries even when a current registration already exists', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  const now = Date.UTC(2026, 0, 2, 12)
  const boot = Date.UTC(2026, 0, 2, 11)
  const live: HolderLiveness = {
    ...liveness({ incarnations: { [process.pid]: null } }),
    now: () => now,
    uptime: () => 3_600,
  }
  await register(paths, { liveness: live, now: () => now })
  const current = await holders(dir)
  const stale = {
    ...current.entries[0],
    instance: 'from-previous-boot',
    registeredAt: boot - 5 * 60_000 - 1,
  }
  await writeFile(
    join(dir, HOLDER_FILE_NAME),
    JSON.stringify({ version: 1, entries: [stale, ...current.entries] }),
  )

  resetNativeHolderRegistryForTests()
  await register(paths, { liveness: live, now: () => now })

  expect(await holders(dir)).toEqual(current)
})

test('an unreadable incarnation counts as alive and a matching one is never cleared', async () => {
  const own = await processIncarnation(process.pid)
  expect(await holderEntryIsLive({ pid: process.pid, incarnation: own })).toBe(
    true,
  )
  expect(await holderEntryIsLive({ pid: process.pid, incarnation: null })).toBe(
    true,
  )
  expect(
    await holderEntryIsLive(
      { pid: process.pid, incarnation: 'recorded' },
      liveness({ incarnations: { [process.pid]: null } }),
    ),
  ).toBe(true)
  expect(
    await holderEntryIsLive(
      { pid: process.pid, incarnation: 'recorded' },
      liveness({ incarnations: { [process.pid]: 'recorded' } }),
    ),
  ).toBe(true)
  // Without a pre-boot time, only a different incarnation or a dead pid clears it.
  expect(
    await holderEntryIsLive(
      { pid: process.pid, incarnation: 'recorded' },
      liveness({ incarnations: { [process.pid]: 'another' } }),
    ),
  ).toBe(false)
  expect(
    await holderEntryIsLive(
      { pid: 910009, incarnation: null },
      liveness({ dead: [910009] }),
    ),
  ).toBe(false)
})

test('a malformed holder file is never overwritten; an ordinary process keeps serving, logs once and retries', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  const logs = captureLogs()
  const malformed = '{"version": 1, "entries": ['
  await writeFile(join(dir, HOLDER_FILE_NAME), malformed)

  const first = await register(paths, { retryIntervalMs: 20 })
  deferCleanup(() => first.close())
  expect(first.status).toBe('pending')
  // Let a few retries fail too.
  await Bun.sleep(150)
  expect(await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')).toBe(malformed)
  const warnings = logs.filter(
    (record) =>
      record.level === 'warn' &&
      record.message.startsWith('anthropic-auth could not record'),
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.message).toContain(dir)

  // Once the file is repaired, the next retry records the process.
  await rm(join(dir, HOLDER_FILE_NAME))
  await first.settled
  expect((await holders(dir)).entries.map((entry) => entry.pid)).toEqual([
    process.pid,
  ])
})

test('retries of a failed ordinary registration run as background work', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  captureLogs()
  await writeFile(join(dir, HOLDER_FILE_NAME), 'not json')
  const locks = recordLocks()
  const registration = await register(paths, {
    retryIntervalMs: 20,
    onLockEvent: locks.onLockEvent,
  })
  deferCleanup(() => registration.close())
  const foreground = locks.events.length
  await rm(join(dir, HOLDER_FILE_NAME))
  await registration.settled
  const retried = locks.events.slice(foreground)
  expect(retried.length).toBeGreaterThan(0)
  expect(retried.every((event) => event.detached === true)).toBe(true)
})

test('the default retry waits a minute', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  captureLogs()
  await writeFile(join(dir, HOLDER_FILE_NAME), 'not json')
  const scheduled: number[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    scheduled.push(ms ?? 0)
    return realSetTimeout(() => {}, 0)
  }) as typeof setTimeout
  const registration = await register(paths).finally(() => {
    globalThis.setTimeout = realSetTimeout
  })
  registration.close()
  expect(registration.status).toBe('pending')
  expect(scheduled).toContain(60_000)
})

test('a holder-lock timeout leaves an ordinary process serving', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  captureLogs()
  await withLock(
    join(dir, HOLDER_FILE_NAME),
    { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000 },
    async () => {
      const registration = await register(paths, { lockTimeoutMs: 50 })
      registration.close()
      expect(registration.status).toBe('pending')
    },
  )
})

test('an ordinary process records itself only once a dataset file exists, and never creates a folder', async () => {
  const parent = await folder('home')
  const dir = join(parent, 'opencode')
  const paths = await dataset(dir, true)
  const locks = recordLocks()
  const registration = await register(paths, {
    retryIntervalMs: 20,
    onLockEvent: locks.onLockEvent,
  })
  deferCleanup(() => registration.close())
  expect(registration.status).toBe('pending')
  expect(await readdir(parent)).toEqual([])
  await mkdir(dir)
  await Bun.sleep(100)
  // A folder holding only the account file has nothing to record yet.
  await writeFile(paths.legacyConfig, '{}')
  await Bun.sleep(100)
  expect((await readdir(dir)).sort()).toEqual(['anthropic-auth.json'])
  expect(locks.events).toEqual([])
  await writeFile(paths.journal, '{}')
  await registration.settled
  expect((await holders(dir)).entries).toHaveLength(1)
})

for (const kind of ['explicit', 'pi'] as const) {
  test(`a ${kind} dataset in a destination-shaped folder refuses when its registration fails`, async () => {
    const dir = await folder('state', 'cortexkit', 'anthropic-auth', 'opencode')
    expect(isDestinationShapedDirectory(dir)).toBe(true)
    const paths = await dataset(dir)
    captureLogs()

    await writeFile(join(dir, HOLDER_FILE_NAME), 'not json')
    const malformed = await register(paths, { kind }).catch((error) => error)
    expect(malformed).toBeInstanceOf(HolderRegistrationError)
    expect(malformed).toMatchObject({ code: 'malformed' })
    expect(await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')).toBe('not json')
    await rm(join(dir, HOLDER_FILE_NAME))

    await withLock(
      join(dir, HOLDER_FILE_NAME),
      { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000 },
      async () => {
        const timedOut = await register(paths, {
          kind,
          lockTimeoutMs: 50,
        }).catch((error) => error)
        expect(timedOut).toBeInstanceOf(HolderRegistrationError)
        expect(timedOut).toMatchObject({ code: 'lock-timeout' })
      },
    )

    // With a working folder the same registration succeeds.
    expect((await register(paths, { kind })).status).toBe('registered')
    expect((await holders(dir)).entries[0]).toMatchObject({ kind })
  })
}

test('a legacy dataset in a destination-shaped folder is not required to register', async () => {
  const dir = await folder(
    'state',
    'cortexkit',
    'anthropic-auth',
    'opencode-0123456789abcdef',
  )
  expect(isDestinationShapedDirectory(dir)).toBe(true)
  const paths = await dataset(dir)
  captureLogs()
  await writeFile(join(dir, HOLDER_FILE_NAME), 'not json')
  const registration = await register(paths)
  registration.close()
  expect(registration.status).toBe('pending')
})

test('destination-shaped folders are recognised by path alone', () => {
  for (const dir of [
    '/s/cortexkit/anthropic-auth/opencode',
    '/s/cortexkit/anthropic-auth/opencode-0123456789abcdef',
  ])
    expect(isDestinationShapedDirectory(dir)).toBe(true)
  for (const dir of [
    '/home/u/.config/opencode',
    '/s/cortexkit/anthropic-auth/opencode-0123',
    '/s/cortexkit/anthropic-auth/opencode-0123456789ABCDEF',
    '/s/cortexkit/other/opencode',
    '/s/anthropic-auth/opencode',
  ])
    expect(isDestinationShapedDirectory(dir)).toBe(false)
})

test('an override into a managed folder refuses before writing anything', async () => {
  for (const marker of ['config-dir.json', 'layout.json']) {
    const dir = await folder('managed')
    const paths = await dataset(dir)
    await writeFile(join(dir, marker), '{}')
    for (const kind of ['explicit', 'pi'] as const) {
      const error = await register(paths, { kind }).catch((caught) => caught)
      expect(error).toBeInstanceOf(HolderRegistrationError)
      expect(error).toMatchObject({ code: 'managed-folder' })
    }
    expect((await readdir(dir)).sort()).toEqual(
      ['anthropic-auth-pool-state.json', marker].sort(),
    )
  }
})

test('a relocation tombstone over either runtime refuses registration for every kind', async () => {
  for (const which of ['local', 'vault'] as const) {
    const dir = await folder('opencode')
    const paths = await dataset(dir)
    await tombstone(
      which === 'local'
        ? paths.runtime
        : join(dir, 'anthropic-auth-vault-state.json'),
    )
    for (const kind of ['legacy', 'explicit', 'pi'] as const) {
      const error = await register(paths, { kind }).catch((caught) => caught)
      expect(error).toBeInstanceOf(RelocatedError)
    }
    expect(await readdir(dir)).not.toContain(HOLDER_FILE_NAME)
  }
})

test('a registrant that waited for the holder lock checks for a tombstone again', async () => {
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  let registering: Promise<unknown> | undefined
  await withLock(
    join(dir, HOLDER_FILE_NAME),
    { name: 'holders', ttlMs: 10_000, timeoutMs: 1_000 },
    async () => {
      registering = register(paths, { lockTimeoutMs: 5_000 }).catch(
        (error) => error,
      )
      await Bun.sleep(100)
      // A mover installs its tombstones while it holds this lock.
      await tombstone(paths.runtime)
    },
  )
  expect(await registering).toBeInstanceOf(RelocatedError)
  expect(await readdir(dir)).not.toContain(HOLDER_FILE_NAME)
})

test('a failed write in a read-only folder keeps an ordinary process serving', async () => {
  // Root ignores directory permissions, so the write can't fail there.
  if (process.getuid?.() === 0 || process.platform === 'win32') return
  const dir = await folder('opencode')
  const paths = await dataset(dir)
  captureLogs()
  await chmod(dir, 0o500)
  try {
    const registration = await register(paths)
    registration.close()
    expect(registration.status).toBe('pending')
  } finally {
    // Restore write access so the folder can be removed afterwards.
    await chmod(dir, 0o700)
  }
})

test('OpenCode datasets named by a path override register as explicit', () => {
  expect(openCodeHolderKind({})).toBe('legacy')
  expect(openCodeHolderKind({ OPENCODE_ANTHROPIC_AUTH_FILE: ' ' })).toBe(
    'legacy',
  )
  expect(
    openCodeHolderKind({ OPENCODE_ANTHROPIC_AUTH_FILE: '/x/accounts.json' }),
  ).toBe('explicit')
  expect(
    openCodeHolderKind({
      OPENCODE_ANTHROPIC_AUTH_STATE_FILE: '/x/state.json',
    }),
  ).toBe('explicit')
})

/**
 * Windows' private-files helper, simulated: each folder it creates gets an
 * owner-only ACL; a folder created any other way has none recorded, which
 * the owner-only check refuses.
 */
function windowsFolders() {
  const acl = new Map<string, 'owner-only' | 'permissive'>()
  const created: string[] = []
  const privateFiles = {
    verifyOwnerOnly: async (path: string) =>
      acl.get(path) === 'owner-only'
        ? { ok: true as const }
        : { ok: false as const, refusal: { reason: 'extra-ace' } },
    readPrivateFile: async () => Buffer.alloc(0),
    verifySafeParent: async () => ({ ok: true as const }),
    createPrivateDirectory: async (path: string) => {
      await mkdir(path, { mode: 0o700 })
      acl.set(path, 'owner-only')
      created.push(path)
    },
  }
  return {
    acl,
    created,
    privateFiles,
    ownerOnly: {
      platform: 'win32' as const,
      privateFiles: privateFiles as unknown as OwnerOnlyOptions['privateFiles'],
    },
  }
}

test('Windows: a mandatory registration creates a missing folder, and any missing parent, owner-only', async () => {
  const parent = await folder('shared')
  const dir = join(parent, 'missing', 'opencode')
  const paths = await dataset(dir, true)
  const win = windowsFolders()
  await register(paths, { policy: 'mandatory', ownerOnly: win.ownerOnly })
  expect(win.created).toEqual([join(parent, 'missing'), dir])
  expect(win.acl.get(dir)).toBe('owner-only')
  expect((await holders(dir)).entries).toHaveLength(1)
})

test('Windows: a mandatory registration leaves an existing folder as it is', async () => {
  const dir = await folder('config', 'opencode')
  const paths = await dataset(dir, true)
  const win = windowsFolders()
  await register(paths, { policy: 'mandatory', ownerOnly: win.ownerOnly })
  expect(win.created).toEqual([])
  // Not tightened, and not refused for being shared.
  expect(win.acl.get(dir)).toBeUndefined()
  expect((await holders(dir)).entries).toHaveLength(1)
})

test('Windows: a folder another process created first with a shared ACL is refused, and nothing is written in it', async () => {
  const parent = await folder('shared')
  const dir = join(parent, 'opencode')
  const paths = await dataset(dir, true)
  const win = windowsFolders()
  // The other process wins the creation race.
  win.privateFiles.createPrivateDirectory = async (path: string) => {
    await mkdir(path)
    win.acl.set(path, 'permissive')
    throw Object.assign(new Error('exists'), { code: 'EEXIST' })
  }
  await expect(
    register(paths, { policy: 'mandatory', ownerOnly: win.ownerOnly }),
  ).rejects.toBeInstanceOf(HolderRegistrationError)
  expect(await readdir(dir)).toEqual([])
})
