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

function spawnKeeper(host: Host, storageId: string, root: string, now: number) {
  const online = Promise.withResolvers<{ tracked: number; sent: number }>()
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures', 'cachekeep-process.ts'),
      host,
      storageId,
      root,
      String(now),
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
