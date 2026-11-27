import { expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectVaultRoster } from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import { runWithRequestSignal } from '../request-abort.ts'
import {
  getStickyRoutingStatePath,
  STICKY_ROUTING_ASSIGNMENT_TTL_MS,
  StickySessionRouter,
} from '../sticky-routing.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const lifetimes = createTestLifetimeSuite()
const key = (session: string) =>
  createHash('sha256').update(session).digest('hex')
const input = (sessionId: string, accountId = 'main') => ({
  sessionId,
  family: 'general' as const,
  modelId: 'claude-sonnet-5',
  candidates: [{ accountId, order: 0, quota: { kind: 'unknown' as const } }],
  retainAccountIds: new Set(['main', 'other']),
  storage: null,
  inputBytes: 1,
})
async function fixture(now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'sticky-held-lock-'))
  const path = join(directory, 'routing.json')
  const routers: StickySessionRouter[] = []
  const leases: Array<
    NonNullable<Awaited<ReturnType<typeof acquireRefreshFileLock>>>
  > = []
  lifetimes.deferCleanup(async () => {
    await Promise.all(leases.map((lease) => lease.release()))
    await Promise.all(routers.map((router) => router.drain()))
    await rm(directory, { recursive: true, force: true })
  })
  const router = (
    onLockEvent?: (event: NativeLockEvent) => void,
    localRecoveryPath?: string,
  ) => {
    const value = new StickySessionRouter({
      path,
      now,
      onLockEvent,
      localRecoveryPath,
    })
    routers.push(value)
    return value
  }
  const hold = async () => {
    const lease = await acquireRefreshFileLock({
      path,
      name: 'write',
      ttlMs: 60_000,
      renew: true,
    })
    if (!lease) throw new Error('Fixture lock not acquired')
    leases.push(lease)
    return lease
  }
  return { directory, path, router, hold }
}

function delayNextWriter(router: StickySessionRouter) {
  const waiting = lifetimes.gate()
  const resume = lifetimes.gate()
  const seam = router as unknown as {
    acquireLock(wait?: boolean, detached?: boolean): Promise<unknown>
  }
  const acquire = seam.acquireLock
  seam.acquireLock = async (...args) => {
    seam.acquireLock = acquire
    waiting.open()
    await resume.wait
    return acquire.apply(router, args)
  }
  return { waiting: waiting.wait, resume: resume.open }
}

function stickyWarnings() {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('warn')
  __setLogTestSink((record) => {
    if (record.channel === 'sticky-routing') records.push(record)
  })
  lifetimes.deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
  })
  return records
}

lifetimes.test(
  'an aborted request cannot publish a prepared sticky pin migration',
  async () => {
    const f = await fixture()
    const router = f.router()
    await router.resolve(input('aborted-migration'))
    await router.drain()
    const before = await readFile(f.path, 'utf8')
    const entered = lifetimes.gate()
    const release = lifetimes.gate()
    const finished = lifetimes.gate()
    const controller = new AbortController()
    const migration = {
      ...input('aborted-migration', 'other'),
      excludeAccountIds: new Set(['main']),
    }
    const pending = runWithRequestSignal(controller.signal, async () => {
      expect((await router.resolve(migration))?.accountId).toBe('other')
      entered.open()
      await release.wait
      finished.open()
    })
    await entered.wait
    controller.abort(new Error('request ended before send'))
    await expect(pending).rejects.toBe(controller.signal.reason)
    release.open()
    await finished.wait
    await router.drain()
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect(
      (await router.resolve(input('aborted-migration', 'other')))?.accountId,
    ).toBe('main')
    await runWithRequestSignal(new AbortController().signal, async () => {
      expect((await router.resolve(migration))?.accountId).toBe('other')
    })
    await router.drain()
    expect(
      JSON.parse(await readFile(f.path, 'utf8')).assignments[
        key('aborted-migration')
      ].accountId,
    ).toBe('other')
  },
)

lifetimes.test(
  'sticky routing decisions read published pins without waiting and publish after the writer releases',
  async () => {
    const f = await fixture()
    const a = f.router()
    const attempted = lifetimes.gate()
    let measuring = false
    const b = f.router((event) => {
      if (measuring && !event.detached && event.type === 'acquiring')
        attempted.open()
    })
    await b.resolve(input('unrelated-b', 'other'))
    await b.drain()
    await a.resolve(input('pinned-by-a'))
    await a.drain()
    const held = await f.hold()
    try {
      measuring = true
      const pending = b.resolve(input('pinned-by-a', 'other'))
      lifetimes.trackDetached(pending)
      const result = await Promise.race([
        pending.then((route) => ({ settled: true as const, route })),
        attempted.wait.then(() => ({ settled: false as const })),
      ])
      measuring = false
      expect(result.settled).toBe(true)
      if (!result.settled) return
      expect(result.route?.accountId).toBe('main')
      expect((await b.resolve(input('new-b', 'other')))?.accountId).toBe(
        'other',
      )
      await held.assertOwned()
      const before = JSON.parse(await readFile(f.path, 'utf8'))
      expect(before.assignments[key('new-b')]).toBeUndefined()
      before.assignments[key('late-a')] = {
        ...before.assignments[key('pinned-by-a')],
      }
      await writeFile(f.path, JSON.stringify(before), { mode: 0o600 })
      let drained = false
      const closing = b.drain().then(() => {
        drained = true
      })
      lifetimes.trackDetached(closing)
      await Promise.resolve()
      expect(drained).toBe(false)
      await held.release()
      await closing
      const after = JSON.parse(await readFile(f.path, 'utf8'))
      expect(after.assignments[key('new-b')].accountId).toBe('other')
      expect(after.assignments[key('pinned-by-a')].accountId).toBe('main')
      expect(after.assignments[key('late-a')].accountId).toBe('main')
      expect(after.assignments[key('unrelated-b')].accountId).toBe('other')
    } finally {
      await held.release()
    }
  },
  10_000,
)

lifetimes.test(
  'a sticky pin touched before expiry survives a peer write after expiry',
  async () => {
    const assignedAt = Date.now()
    let now = assignedAt
    const f = await fixture(() => now)
    const a = f.router()
    const b = f.router()
    const session = 'live-pin'
    await a.resolve(input(session))
    await a.drain()

    now = assignedAt + STICKY_ROUTING_ASSIGNMENT_TTL_MS - 1
    const touchedAt = now
    const touch = delayNextWriter(a)
    try {
      expect(await a.resolve(input(session, 'other'))).toMatchObject({
        accountId: 'main',
        created: false,
        assignment: { lastSeenAt: touchedAt },
      })
      await touch.waiting
      now += 2
      expect(await b.readAssignment(session)).toBeUndefined()
      await b.resolve(input('unrelated', 'other'))
      await b.drain()
      expect(await b.readAssignment(session)).toBeUndefined()
    } finally {
      touch.resume()
    }
    await a.drain()
    expect(await b.readAssignment(session)).toMatchObject({
      accountId: 'main',
      lastSeenAt: touchedAt,
    })
  },
)

for (const change of ['cleared', 'reassigned'] as const) {
  lifetimes.test(
    `a delayed touch does not restore a peer's ${change} pin`,
    async () => {
      let now = Date.now()
      const f = await fixture(() => now)
      const a = f.router()
      const b = f.router()
      const session = 'changed-pin'
      await a.resolve(input(session))
      await a.drain()

      now += 24 * 60 * 60_000
      const touch = delayNextWriter(a)
      try {
        expect((await a.resolve(input(session, 'other')))?.accountId).toBe(
          'main',
        )
        await touch.waiting
        if (change === 'cleared') await b.clear(session)
        else
          expect(
            await b.resolve({
              ...input(session, 'other'),
              excludeAccountIds: new Set(['main']),
            }),
          ).toMatchObject({ accountId: 'other', migrated: true })
        await b.drain()
      } finally {
        touch.resume()
      }
      await a.drain()
      const saved = JSON.parse(await readFile(f.path, 'utf8')).assignments
      if (change === 'cleared') expect(saved[key(session)]).toBeUndefined()
      else expect(saved[key(session)].accountId).toBe('other')
    },
  )
}

lifetimes.test(
  'local recovery during prune grace cannot revive a cleared sticky pin through a delayed touch',
  async () => {
    const assignedAt = Date.now()
    let now = assignedAt
    const f = await fixture(() => now)
    const toucher = f.router()
    const peer = f.router()
    const session = 'cleared-pin'
    const legacy = join(f.directory, 'legacy-routing.json')
    await toucher.resolve(input(session))
    await toucher.drain()
    await writeFile(legacy, await readFile(f.path), { mode: 0o600 })

    now = assignedAt + STICKY_ROUTING_ASSIGNMENT_TTL_MS - 1
    const touch = delayNextWriter(toucher)
    try {
      expect(await toucher.resolve(input(session, 'other'))).toMatchObject({
        accountId: 'main',
        created: false,
        assignment: { lastSeenAt: now },
      })
      await touch.waiting
      await peer.clear(session)
      await peer.drain()
      expect(JSON.parse(await readFile(f.path, 'utf8')).assignments).toEqual({})

      now += 2
      const recovering = f.router(undefined, legacy)
      await recovering.resolve(input('unrelated', 'other'))
      await recovering.drain()
    } finally {
      touch.resume()
    }
    await toucher.drain()
    expect(await f.router().readAssignment(session)).toBeUndefined()
    const saved = JSON.parse(await readFile(f.path, 'utf8')).assignments
    expect(saved[key(session)]).toBeUndefined()
    expect(saved[key('unrelated')].accountId).toBe('other')
  },
)

lifetimes.test(
  'sticky routing assignment prunes the locked state without losing a live peer pin',
  async () => {
    const f = await fixture()
    const contended = lifetimes.gate()
    const router = f.router((event) => {
      if (event.detached && event.type === 'contended') contended.open()
    })
    const now = Date.now()
    const pin = (lastSeenAt: number) => ({
      accountId: 'main',
      family: 'general',
      affinityModelId: 'claude-sonnet-5',
      assignedAt: lastSeenAt,
      lastSeenAt,
      initialInputBytes: 1,
      quotaCheckedAt: 0,
    })
    const assignments = Object.fromEntries(
      Array.from({ length: 4096 }, (_, index) => [
        key(`live-${index}`),
        pin(index < 2 ? now - 10_000 + index : now - 1_000),
      ]),
    )
    assignments[key('expired')] = pin(now - 8 * 24 * 60 * 60_000)
    await writeFile(
      f.path,
      JSON.stringify({ version: 1, updatedAt: now, assignments }),
      { mode: 0o600 },
    )
    const held = await f.hold()
    try {
      expect((await router.resolve(input('fresh')))?.accountId).toBe('main')
      await contended.wait
      // Publish a late peer pin under the fixture's lease, after routing has read the file.
      const peer = spawnSync(
        process.execPath,
        [
          '-e',
          `
      const [path, key, assignment] = process.argv.slice(1);
      const { readFileSync, writeFileSync } = require('node:fs');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      state.assignments[key] = JSON.parse(assignment);
      writeFileSync(path, JSON.stringify(state));
    `,
          f.path,
          key('late-peer'),
          JSON.stringify({ ...pin(now), accountId: 'other' }),
        ],
        { encoding: 'utf8' },
      )
      expect(peer.stderr).toBe('')
      expect(peer.status).toBe(0)
      await held.assertOwned()
    } finally {
      await held.release()
    }
    await router.drain()
    const saved = JSON.parse(await readFile(f.path, 'utf8')).assignments
    expect(Object.keys(saved)).toHaveLength(4096)
    expect(saved[key('expired')]).toBeUndefined()
    expect(saved[key('live-0')]).toBeUndefined()
    expect(saved[key('live-1')]).toBeUndefined()
    expect(saved[key('live-2')]).toEqual(assignments[key('live-2')])
    expect(saved[key('late-peer')]).toEqual({ ...pin(now), accountId: 'other' })
    expect(saved[key('fresh')].accountId).toBe('main')
  },
)

lifetimes.test(
  'sticky routing local recovery prunes expired imports and keeps live pins',
  async () => {
    const now = Date.now()
    const f = await fixture(() => now)
    const legacy = join(f.directory, 'legacy-routing.json')
    const live = {
      accountId: 'main',
      family: 'general',
      affinityModelId: 'claude-sonnet-5',
      assignedAt: now,
      lastSeenAt: now,
      initialInputBytes: 1,
      quotaCheckedAt: 0,
    }
    const expired = now - 8 * 24 * 60 * 60_000
    const graceKept = now - STICKY_ROUTING_ASSIGNMENT_TTL_MS - 1
    await writeFile(
      f.path,
      JSON.stringify({
        version: 1,
        updatedAt: now,
        assignments: {
          [key('replace-expired')]: {
            ...live,
            accountId: 'other',
            assignedAt: graceKept,
            lastSeenAt: graceKept,
          },
        },
      }),
      { mode: 0o600 },
    )
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        updatedAt: now,
        assignments: {
          [key('live')]: live,
          [key('replace-expired')]: live,
          [key('expired')]: {
            ...live,
            assignedAt: expired,
            lastSeenAt: expired,
          },
        },
      }),
      { mode: 0o600 },
    )
    const router = f.router(undefined, legacy)
    expect(
      await router.resolve({ ...input('no-route'), candidates: [] }),
    ).toBeNull()
    await router.drain()
    expect(JSON.parse(await readFile(f.path, 'utf8')).assignments).toEqual({
      [key('live')]: live,
      [key('replace-expired')]: live,
    })
  },
)

lifetimes.test(
  'vault seeding imports a live legacy pin over a grace-kept expired pin',
  async () => {
    const assignedAt = Date.now()
    let now = assignedAt
    const f = await fixture(() => now)
    const peer = f.router()
    const session = 'legacy-pin'
    const expiredSession = 'expired-source'
    const legacyConfig = join(f.directory, 'legacy.json')
    const accountIdentity = '11111111-2222-4333-8444-555555555555'
    const roster = projectVaultRoster(
      undefined,
      {
        view: 'verified',
        credentials: [
          {
            credentialId: 'oauth:anthropic',
            credentialType: 'oauth',
            accountIdentity,
            state: 'active',
          },
        ],
        skipped: [],
      },
      { now },
    )
    const routeId = roster.rows[0]?.routeId
    if (!routeId) throw new Error('Fixture roster has no route')
    await writeFile(
      legacyConfig,
      JSON.stringify({ mainAccountId: accountIdentity }),
      {
        mode: 0o600,
      },
    )
    const oldPin = {
      accountId: 'other',
      affinityModelId: 'claude-sonnet-5',
      family: 'general' as const,
      assignedAt,
      lastSeenAt: assignedAt,
      initialInputBytes: 1,
      quotaCheckedAt: 0,
    }
    const legacyPin = {
      ...oldPin,
      accountId: 'main',
      lastSeenAt: assignedAt + 6 * 24 * 60 * 60_000,
    }
    await writeFile(
      getStickyRoutingStatePath(legacyConfig),
      JSON.stringify({
        version: 1,
        updatedAt: legacyPin.lastSeenAt,
        assignments: {
          [key(session)]: legacyPin,
          [key(expiredSession)]: { ...oldPin, accountId: 'main' },
        },
      }),
      { mode: 0o600 },
    )
    await writeFile(
      f.path,
      JSON.stringify({
        version: 1,
        updatedAt: assignedAt,
        assignments: { [key(session)]: oldPin },
        vaultLegacySeed: 'pending',
      }),
      { mode: 0o600 },
    )

    now = assignedAt + STICKY_ROUTING_ASSIGNMENT_TTL_MS + 1
    await peer.resolve(input('unrelated'))
    await peer.drain()
    expect(await peer.readAssignment(session)).toBeUndefined()
    const before = JSON.parse(await readFile(f.path, 'utf8'))
    expect(before.vaultLegacySeed).toBe('pending')
    expect(before.assignments[key(session)]).toEqual(oldPin)

    const seeder = f.router()
    seeder.setVaultSeed({
      legacyConfig,
      roster: join(f.directory, 'roster.json'),
    })
    await seeder.prepareLegacySeed(roster)
    await seeder.drain()
    const saved = JSON.parse(await readFile(f.path, 'utf8'))
    expect(saved.vaultLegacySeed).toBe('complete')
    expect(await seeder.readAssignment(session)).toEqual({
      ...legacyPin,
      accountId: routeId,
      accountIdentity,
    })
    expect(saved.assignments[key(expiredSession)]).toBeUndefined()
  },
)

for (const operation of ['assign', 'clear', 'seed'] as const) {
  lifetimes.test(
    `sticky routing ${operation} publishes after a held bookkeeping lock is released`,
    async () => {
      const f = await fixture()
      const router = f.router()
      const assignment = {
        accountId: 'main',
        family: 'general',
        affinityModelId: 'claude-sonnet-5',
        assignedAt: Date.now(),
        lastSeenAt: Date.now(),
        initialInputBytes: 1,
        quotaCheckedAt: 0,
      }
      const state = {
        version: 1,
        updatedAt: Date.now(),
        assignments:
          operation === 'clear'
            ? { [key('session')]: assignment }
            : operation === 'seed'
              ? { [key('expired')]: { ...assignment, lastSeenAt: 1 } }
              : {},
        ...(operation === 'seed' ? { vaultLegacySeed: 'pending' } : {}),
      }
      const bytes = JSON.stringify(state)
      await writeFile(f.path, bytes, { mode: 0o600 })
      const held = await f.hold()
      if (operation === 'assign')
        expect((await router.resolve(input('session')))?.accountId).toBe('main')
      else if (operation === 'clear') {
        await router.clear('session')
        expect(
          await router.resolve({ ...input('session'), candidates: [] }),
        ).toBeNull()
      } else {
        router.setVaultSeed({
          legacyConfig: join(f.directory, 'legacy.json'),
          roster: join(f.directory, 'roster.json'),
        })
        await router.prepareLegacySeed({
          version: 1,
          complete: true,
          rows: [],
          declined: [],
        })
      }
      await held.assertOwned()
      expect(await readFile(f.path, 'utf8')).toBe(bytes)
      await held.release()
      await router.drain()
      const published = JSON.parse(await readFile(f.path, 'utf8'))
      if (operation === 'assign')
        expect(published.assignments[key('session')].accountId).toBe('main')
      else if (operation === 'clear') expect(published.assignments).toEqual({})
      else {
        expect(published.vaultLegacySeed).toBe('complete')
        expect(published.assignments).toEqual({})
      }
    },
  )
}

lifetimes.test(
  'sticky routing preserves invalid state once and persists new assignments',
  async () => {
    const f = await fixture()
    const invalid = '{"version":2,"assignments":{}}\n'
    await writeFile(f.path, invalid, { mode: 0o644 })
    const records = stickyWarnings()

    const router = f.router()
    expect((await router.resolve(input('first')))?.accountId).toBe('main')
    await router.drain()
    const another = f.router()
    expect((await another.resolve(input('second', 'other')))?.accountId).toBe(
      'other',
    )
    await another.drain()

    const state = JSON.parse(await readFile(f.path, 'utf8'))
    expect(state.version).toBe(1)
    expect(state.assignments[key('first')].accountId).toBe('main')
    expect(state.assignments[key('second')].accountId).toBe('other')
    const backups = (await readdir(f.directory)).filter((name) =>
      name.startsWith('routing.json.invalid-'),
    )
    expect(backups).toHaveLength(1)
    const [backupName] = backups
    if (!backupName) throw new Error('Invalid state backup missing')
    const backup = join(f.directory, backupName)
    expect(await readFile(backup, 'utf8')).toBe(invalid)
    expect((await stat(backup)).mode & 0o777).toBe(0o600)
    expect(records.map((record) => record.message)).toEqual([
      'invalid state set aside',
    ])
  },
)

lifetimes.test(
  'sticky routing serves requests without waiting and rechecks invalid state after contention',
  async () => {
    const f = await fixture()
    const records = stickyWarnings()
    const contended = lifetimes.gate()
    const router = f.router((event) => {
      if (event.detached && event.type === 'contended') contended.open()
    })
    await router.resolve(input('existing'))
    await router.drain()
    const valid = await readFile(f.path, 'utf8')
    const invalid = '{'
    const held = await f.hold()
    try {
      await writeFile(f.path, invalid)
      expect(await router.readAssignment('existing')).toBeUndefined()
      expect(
        await router.resolve({ ...input('existing'), candidates: [] }),
      ).toBeNull()
      expect(records).toEqual([])
      expect((await router.resolve(input('new', 'other')))?.accountId).toBe(
        'other',
      )
      await contended.wait
      expect(await readFile(f.path, 'utf8')).toBe(invalid)
      await held.assertOwned()
      await writeFile(f.path, valid)
    } finally {
      await held.release()
    }
    await router.drain()
    const state = JSON.parse(await readFile(f.path, 'utf8'))
    expect(state.assignments[key('existing')].accountId).toBe('main')
    expect(state.assignments[key('new')].accountId).toBe('other')
    expect(await readdir(f.directory)).toEqual(['routing.json'])
    expect(records).toEqual([])
  },
)

lifetimes.test(
  'sticky routing still reports an unreadable state without setting it aside',
  async () => {
    const f = await fixture()
    await mkdir(f.path)
    const records = stickyWarnings()
    const router = f.router()
    expect((await router.resolve(input('unreadable')))?.accountId).toBe('main')
    await router.drain()
    expect((await stat(f.path)).isDirectory()).toBe(true)
    expect(await readdir(f.directory)).toEqual(['routing.json'])
    expect(records).toMatchObject([
      {
        message: 'assignment write refused',
        payload: { operation: 'assign', reason: 'storage-unavailable' },
      },
    ])
  },
)

lifetimes.test(
  'sticky routing warns once for invalid bytes when repair keeps failing',
  async () => {
    const f = await fixture()
    const invalid = '{"version":2}'
    await writeFile(f.path, invalid)
    const records = stickyWarnings()
    let attempts = 0
    for (const sessionId of ['one', 'two']) {
      const router = new StickySessionRouter({
        path: f.path,
        relocationGuard: {
          assertNotRelocated: async () => {
            attempts++
            throw new Error('routing state relocated')
          },
        },
      })
      try {
        expect((await router.resolve(input(sessionId)))?.accountId).toBe('main')
      } finally {
        await router.drain()
      }
    }
    expect(attempts).toBe(2)
    expect(await readFile(f.path, 'utf8')).toBe(invalid)
    expect(await readdir(f.directory)).toEqual(['routing.json'])
    expect(records.map((record) => record.message)).toEqual([
      'invalid state could not be set aside',
    ])
  },
)

lifetimes.test(
  'failed sticky publication logs once, preserves its choice, and retries on the next resolve',
  async () => {
    const f = await fixture()
    const router = f.router()
    const seam = router as unknown as {
      writeState(...args: unknown[]): Promise<void>
    }
    const write = seam.writeState.bind(router)
    let refuse = true
    seam.writeState = async (...args) => {
      if (refuse) {
        refuse = false
        throw new Error('synthetic private write failure')
      }
      return write(...args)
    }
    const records: LogTestRecord[] = []
    const previous = getLogLevel()
    setLogLevel('warn')
    __setLogTestSink((record) => records.push(record))
    lifetimes.deferCleanup(() => {
      __setLogTestSink(null)
      setLogLevel(previous)
    })
    expect((await router.resolve(input('retry')))?.accountId).toBe('main')
    await router.drain()
    expect(await readFile(f.path, 'utf8').catch(() => null)).toBeNull()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      channel: 'sticky-routing',
      message: 'assignment write refused',
      payload: { operation: 'assign', reason: 'storage-unavailable' },
    })
    expect((await router.resolve(input('retry', 'other')))?.accountId).toBe(
      'main',
    )
    await router.drain()
    expect(
      JSON.parse(await readFile(f.path, 'utf8')).assignments[key('retry')]
        .accountId,
    ).toBe('main')
    expect(records).toHaveLength(1)
  },
)

lifetimes.test(
  'a clear supersedes an assignment already waiting for the writer lease',
  async () => {
    const f = await fixture()
    const entered = lifetimes.gate()
    const router = f.router((event) => {
      if (event.detached && event.type === 'acquiring') entered.open()
    })
    const seam = router as unknown as {
      writeState(
        state: { assignments: Record<string, { accountId: string }> },
        beforeRename: () => Promise<void>,
        prune?: boolean,
      ): Promise<void>
    }
    const write = seam.writeState.bind(router)
    const published: Array<string | undefined> = []
    seam.writeState = async (...args) => {
      published.push(args[0].assignments[key('superseded')]?.accountId)
      return write(...args)
    }
    const held = await f.hold()
    try {
      expect((await router.resolve(input('superseded')))?.accountId).toBe(
        'main',
      )
      await entered.wait
      await router.clear('superseded')
      await held.assertOwned()
    } finally {
      await held.release()
    }
    await router.drain()
    expect(published).toEqual([undefined])
    expect(
      JSON.parse(await readFile(f.path, 'utf8')).assignments[key('superseded')],
    ).toBeUndefined()
  },
)
