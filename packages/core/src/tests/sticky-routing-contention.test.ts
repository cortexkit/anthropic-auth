import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import { runWithRequestSignal } from '../request-abort.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
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
async function fixture() {
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
  const router = (onLockEvent?: (event: NativeLockEvent) => void) => {
    const value = new StickySessionRouter({ path, onLockEvent })
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
          operation === 'clear' ? { [key('session')]: assignment } : {},
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
      else expect(published.vaultLegacySeed).toBe('complete')
    },
  )
}

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
