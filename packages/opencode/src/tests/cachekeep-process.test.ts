import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  CACHE_KEEP_PREWARM_LEAD_MS,
  CacheKeepStore,
  cacheKeepStoreDirectory,
} from '@cortexkit/anthropic-auth-core'
import { type Host, openKeeper } from './fixtures/cachekeep-process.ts'

function spawnKeeper(
  host: Host,
  storageId: string,
  root: string,
  now: number,
  action = '',
) {
  const online = Promise.withResolvers<{ tracked: number; sent: number }>()
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures', 'cachekeep-process.ts'),
      host,
      storageId,
      root,
      String(now),
      action,
    ],
    {
      env: { ...process.env, XDG_DATA_HOME: root },
      stdin: 'pipe',
      stderr: 'inherit',
      ipc(message) {
        online.resolve(message as { tracked: number; sent: number })
      },
    },
  )
  void child.exited.then((code) =>
    online.reject(new Error(`Keeper exited before reporting: ${code}`)),
  )
  return {
    child,
    online: online.promise,
    async close(command = '') {
      if (command) child.stdin.write(command)
      await child.stdin.end()
      expect(await child.exited).toBe(0)
    },
  }
}

test.each(['opencode1', 'opencode2'] as const)(
  '%s restores and warms a shared session only in the owning process',
  async (host) => {
    const root = await mkdtemp(join(tmpdir(), 'shared-cachekeep-'))
    const dataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = root
    const storageId = join(root, 'accounts.json')
    const directory = cacheKeepStoreDirectory(
      storageId,
      root,
      host === 'opencode1' ? host : undefined,
    )
    const readSaved = async () => {
      const [name] = (await readdir(directory)).filter((entry) =>
        entry.endsWith('.json.gz'),
      )
      expect(name).toBeDefined()
      return JSON.parse(
        gunzipSync(await readFile(join(directory, name!))).toString(),
      )
    }
    const children = new Set<ReturnType<typeof spawnKeeper>>()
    const disposals: Array<() => Promise<void>> = []
    let now = Date.now()
    const start = async () => {
      const keeper = await openKeeper(host, storageId, root, () => now)
      disposals.push(keeper.dispose)
      return keeper
    }
    const child = () => {
      const running = spawnKeeper(host, storageId, root, now)
      children.add(running)
      return running
    }
    try {
      const initial = await start()
      expect(await initial.prepare()).toEqual({ tracked: true })
      await initial.dispose()
      const saved = await readSaved()
      const owner = await start()
      expect(owner.manager.trackedCount()).toBe(1)
      now = saved.cacheExpiresAt - CACHE_KEEP_PREWARM_LEAD_MS + 1

      const duplicate = child()
      expect(await duplicate.online).toEqual({ tracked: 0, sent: 0 })
      await duplicate.close()
      expect(await readSaved()).toEqual(saved)
      await owner.dispose()

      const successor = child()
      expect(await successor.online).toEqual({ tracked: 1, sent: 1 })
      const warmed = await readSaved()
      expect(warmed.policyState.warmsSinceLastRealRequest).toBe(1)

      const returning = await start()
      expect(returning.manager.trackedCount()).toBe(0)
      await returning.manager.tick()
      expect(returning.sent()).toBe(0)
      const sweep = new CacheKeepStore({
        storageId,
        root,
        host: host === 'opencode1' ? host : undefined,
        pluginVersion: 'test',
        sessionClaims: true,
      })
      await sweep.load(now, () => 'invalid', undefined, undefined, 'sweep')
      sweep.clear()
      await sweep.drain()
      expect(await readSaved()).toEqual(warmed)

      await successor.close('delete')
      await returning.dispose()
      const afterDelete = await start()
      expect(afterDelete.manager.trackedCount()).toBe(0)
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.json.gz')),
      ).toEqual([])
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
      for (const dispose of disposals.reverse()) await dispose()
      if (dataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = dataHome
      await rm(root, { recursive: true, force: true })
    }
  },
)

async function withRestoredOwner(
  host: Host,
  check: (input: {
    owner: Awaited<ReturnType<typeof openKeeper>>
    start: () => Promise<Awaited<ReturnType<typeof openKeeper>>>
    child: (action?: string) => ReturnType<typeof spawnKeeper>
    due: () => void
    saved: () => Promise<string[]>
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'shared-cachekeep-'))
  const dataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  const storageId = join(root, 'accounts.json')
  const directory = cacheKeepStoreDirectory(
    storageId,
    root,
    host === 'opencode1' ? host : undefined,
  )
  const children: ReturnType<typeof spawnKeeper>[] = []
  const disposals: Array<() => Promise<void>> = []
  let now = Date.now()
  const start = async () => {
    const keeper = await openKeeper(host, storageId, root, () => now)
    disposals.push(keeper.dispose)
    return keeper
  }
  try {
    const seed = await start()
    expect(await seed.prepare()).toEqual({ tracked: true })
    await seed.dispose()
    const owner = await start()
    expect(owner.manager.trackedCount()).toBe(1)
    await check({
      owner,
      start,
      child(action) {
        const running = spawnKeeper(host, storageId, root, now, action)
        children.push(running)
        return running
      },
      due() {
        now += 60 * 60_000 - CACHE_KEEP_PREWARM_LEAD_MS + 1
      },
      saved: () =>
        readdir(directory).then(async (files) => {
          return Promise.all(
            files
              .filter((name) => name.endsWith('.json.gz'))
              .map(async (name) => {
                const record = JSON.parse(
                  gunzipSync(await readFile(join(directory, name))).toString(),
                )
                return record.bodyText as string
              }),
          )
        }),
    })
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
    for (const dispose of disposals.reverse()) await dispose()
    if (dataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = dataHome
    await rm(root, { recursive: true, force: true })
  }
}

test.each(['opencode1', 'opencode2'] as const)(
  '%s yields a restore-only claim to a real turn in another process',
  (host) =>
    withRestoredOwner(host, async ({ owner, child, due, saved }) => {
      const working = child('turn')
      expect(await working.online).toEqual({ tracked: 1, sent: 1 })
      expect((await saved())[0]).toContain('A new real turn')
      due()
      const routing = Symbol.for('cortexkit.routing')
      const globals = globalThis as Record<symbol, unknown>
      const previous = globals[routing]
      const reports: { kind: string }[] = []
      globals[routing] = () => ({
        cache: () => null,
        report: (report: { kind: string }) => reports.push(report),
      })
      try {
        await owner.manager.tick()
        await Bun.sleep(0)
        expect(
          reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
        ).toEqual([])
      } finally {
        if (previous === undefined) delete globals[routing]
        else globals[routing] = previous
      }
      expect(owner.sent()).toBe(0)
      expect(owner.manager.trackedCount()).toBe(0)
      await working.close()
    }),
)

test.each(['opencode1', 'opencode2'] as const)(
  '%s keeps the claim when its restoring process accepts a real turn',
  (host) =>
    withRestoredOwner(host, async ({ owner, child, due, saved }) => {
      expect(await owner.prepare('Real turn in the owner')).toEqual({
        tracked: true,
      })
      due()
      await owner.manager.tick()
      expect(owner.sent()).toBe(1)
      expect((await saved())[0]).toContain('Real turn in the owner')
      const contender = child('turn')
      expect(await contender.online).toEqual({ tracked: 1, sent: 0 })
      expect((await saved())[0]).toContain('Real turn in the owner')
      await contender.close()
    }),
)

test.each(['opencode1', 'opencode2'] as const)(
  '%s forgets a saved session from a non-owner after its startup scan',
  (host) =>
    withRestoredOwner(host, async ({ owner, child, start, saved }) => {
      const deleting = child()
      expect(await deleting.online).toEqual({ tracked: 0, sent: 0 })
      await owner.dispose()
      expect(await saved()).toHaveLength(1)
      await deleting.close('delete')
      expect(await saved()).toEqual([])
      expect((await start()).manager.trackedCount()).toBe(0)
    }),
)

test.each(['opencode1', 'opencode2'] as const)(
  '%s honors deletion from another process before warming',
  (host) =>
    withRestoredOwner(host, async ({ owner, child, due, saved }) => {
      const deleting = child()
      expect(await deleting.online).toEqual({ tracked: 0, sent: 0 })
      await deleting.close('delete')
      due()
      await owner.manager.tick()
      expect(owner.sent()).toBe(0)
      expect(owner.manager.trackedCount()).toBe(0)
      expect(await saved()).toEqual([])
    }),
)
