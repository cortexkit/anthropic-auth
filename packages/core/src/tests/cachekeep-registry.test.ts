import { afterEach, expect, test } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

import {
  CACHE_KEEP_REGISTRY_LEASE_MS,
  CacheKeepSessionRegistry,
  type CacheKeepTrackedSession,
  getCacheKeepRegistryDirectories,
  getDefaultCacheKeepRegistryDirectory,
  getLegacyCacheKeepRegistryDirectory,
} from '../cachekeep-registry.ts'
import { getHostDataHome } from '../host-paths.ts'
import type { OwnerOnlyOptions } from '../owner-only.ts'
import { normalizeRecord as read253 } from './fixtures/cachekeep-registry-2.5.3.ts'

const directories: string[] = []

async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'cachekeep-registry-test-'))
  directories.push(directory)
  return directory
}

function session(id: string): CacheKeepTrackedSession {
  const cacheExpiresAt = Date.now() + 60 * 60_000
  return { id, cacheExpiresAt, nextPrewarmAt: cacheExpiresAt - 5 * 60_000 }
}

function record(updatedAt: number, sessions: CacheKeepTrackedSession[] = []) {
  return { version: 1 as const, updatedAt, sessions }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('reader removes an expired record belonging to another instance', async () => {
  const directory = await makeDirectory()
  await writeFile(
    join(directory, '2147483647-stopped.json'),
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_stopped'),
      ]),
    ),
  )
  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })

  expect(await reader.list()).toEqual([])
  expect(await readdir(directory)).toEqual([])
})

test('reader keeps a fresh record belonging to another instance', async () => {
  const directory = await makeDirectory()
  const fresh = session('ses_fresh')
  await writeFile(
    join(directory, 'active.json'),
    JSON.stringify(record(Date.now(), [fresh])),
  )
  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })

  expect(await reader.list()).toEqual([fresh])
  expect(await readdir(directory)).toEqual(['active.json'])
})

test('a record republished while a sweep runs is kept', async () => {
  const directory = await makeDirectory()
  const recordPath = join(directory, '2147483647-publisher.json')
  await writeFile(
    recordPath,
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_old'),
      ]),
    ),
  )
  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })
  const publisher = new CacheKeepSessionRegistry({
    directory,
    instanceId: '2147483647-publisher',
  })
  const republished = session('ses_republished')

  await Promise.all([reader.list(), publisher.publish([republished])])

  expect(await reader.list()).toEqual([republished])
  const saved = JSON.parse(await readFile(recordPath, 'utf8'))
  expect(saved.updatedAt).toBeGreaterThan(
    Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS,
  )
  expect(saved.sessions).toEqual([republished])
})

test('concurrent sweepers tolerate another sweeper moving an expired record', async () => {
  const directory = await makeDirectory()
  await writeFile(
    join(directory, '2147483647-stopped.json'),
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_stopped'),
      ]),
    ),
  )
  const first = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'first-reader',
  })
  const second = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'second-reader',
  })

  const results = await Promise.all([first.list(), second.list()])
  expect(results).toEqual([[], []])
  expect(await readdir(directory)).toEqual([])
})

test('a sweep never removes this instance record even if its timestamp is expired', async () => {
  const directory = await makeDirectory()
  const recordPath = join(directory, 'owner.json')
  await writeFile(
    recordPath,
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_owner'),
      ]),
    ),
  )
  const owner = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'owner',
  })

  expect(await owner.list()).toEqual([])
  expect(await readdir(directory)).toEqual(['owner.json'])
})

test('publishing also sweeps expired records from other instances', async () => {
  const directory = await makeDirectory()
  await writeFile(
    join(directory, '2147483647-stopped.json'),
    JSON.stringify(
      record(Date.now() - CACHE_KEEP_REGISTRY_LEASE_MS - 1, [
        session('ses_stopped'),
      ]),
    ),
  )
  const publisher = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'publisher',
  })

  await publisher.publish([session('ses_live')])

  expect(await readdir(directory)).toEqual(['publisher.json'])
})

test('published records carry a writer stamp beside version 1 and stay readable', async () => {
  const directory = await makeDirectory()
  const writer = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'writer',
  })
  const tracked = session('ses_stamped')
  await writer.publish([tracked])
  const stored = JSON.parse(
    await readFile(join(directory, 'writer.json'), 'utf8'),
  )
  expect(stored.version).toBe(1)
  expect(stored.writer).toMatchObject({ protocol: 1 })
  expect(typeof stored.writer.release).toBe('string')

  const reader = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'reader',
  })
  expect(await reader.list()).toEqual([tracked])
})

test('data home uses XDG or the shared host home resolver, including Windows paths', () => {
  expect(getHostDataHome({ HOME: '/home/test' }, 'linux', posix)).toBe(
    '/home/test/.local/share',
  )
  expect(
    getHostDataHome(
      { HOME: '/home/test', XDG_DATA_HOME: ' /data ' },
      'linux',
      posix,
    ),
  ).toBe('/data')
  expect(
    getHostDataHome(
      { USERPROFILE: 'C:\\Users\\test', HOME: 'C:\\wrong' },
      'win32',
      win32,
    ),
  ).toBe('C:\\Users\\test\\.local\\share')
  expect(
    getHostDataHome(
      { USERPROFILE: 'C:\\Users\\test', XDG_DATA_HOME: 'D:\\data' },
      'win32',
      win32,
    ),
  ).toBe('D:\\data')
  expect(getDefaultCacheKeepRegistryDirectory('pi')).toBe(
    join(
      getHostDataHome(),
      'cortexkit',
      'anthropic-auth',
      'cachekeep-sessions',
      'pi',
    ),
  )
})

test('registry path overrides win for both hosts without writing to default folders', () => {
  const env = {
    XDG_DATA_HOME: '/data',
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: '/oc-override',
    PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: '/pi-override',
  }
  expect(getCacheKeepRegistryDirectories('opencode', undefined, env)).toEqual({
    directory: '/oc-override',
    legacyDirectory: undefined,
  })
  expect(getCacheKeepRegistryDirectories('pi', undefined, env)).toEqual({
    directory: '/pi-override',
    legacyDirectory: undefined,
  })
  expect(getCacheKeepRegistryDirectories('opencode', '/explicit', env)).toEqual(
    { directory: '/explicit', legacyDirectory: undefined },
  )
  const data = join(tmpdir(), 'cachekeep-data')
  expect(
    getCacheKeepRegistryDirectories('pi', undefined, { XDG_DATA_HOME: data }),
  ).toEqual({
    directory: join(
      data,
      'cortexkit',
      'anthropic-auth',
      'cachekeep-sessions',
      'pi',
    ),
    legacyDirectory: getLegacyCacheKeepRegistryDirectory('pi'),
  })
  expect(
    getDefaultCacheKeepRegistryDirectory(
      'opencode',
      { USERPROFILE: 'C:\\Users\\test' },
      'win32',
      win32,
    ),
  ).toBe(
    'C:\\Users\\test\\.local\\share\\cortexkit\\anthropic-auth\\cachekeep-sessions\\opencode',
  )
})

test('dual publication is private, merges both folders, and is accepted by the 2.5.3 parser', async () => {
  const directory = await makeDirectory()
  const legacyDirectory = await makeDirectory()
  const now = Date.now()
  const writer = new CacheKeepSessionRegistry({
    directory,
    legacyDirectory,
    instanceId: 'writer',
    now: () => now,
  })
  const tracked: CacheKeepTrackedSession = {
    id: 'ses_new',
    cacheExpiresAt: now + 3_600_000,
    nextPrewarmAt: now + 3_300_000,
    ttlMs: 3_600_000,
    lastTouchAt: now,
    lastTouchKind: 'warm',
    warmStopped: { at: now, reason: 'cost-cap' },
  }
  await writer.publish([tracked])
  const raw = await readFile(join(directory, 'writer.json'), 'utf8')
  expect(await readFile(join(legacyDirectory, 'writer.json'), 'utf8')).toBe(raw)
  if (process.platform !== 'win32') {
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, 'writer.json'))).mode & 0o777).toBe(
      0o600,
    )
  }
  expect(read253(JSON.parse(raw))).toEqual(
    record(now, [
      {
        id: tracked.id,
        cacheExpiresAt: tracked.cacheExpiresAt,
        nextPrewarmAt: tracked.nextPrewarmAt,
      },
    ]),
  )
  const newer = { ...tracked, cacheExpiresAt: tracked.cacheExpiresAt + 1000 }
  const older = session('ses_old')
  await writeFile(
    join(legacyDirectory, 'other.json'),
    JSON.stringify(record(now, [newer, older])),
  )
  expect(await writer.list()).toEqual([newer, older])
  await writer.dispose()
  expect(await readdir(directory)).toEqual([])
  expect(await readdir(legacyDirectory)).toEqual(['other.json'])
})

test('stale live or unidentifiable process files survive; dead and pre-boot files are removed', async () => {
  const directory = await makeDirectory()
  const now = 10_000_000
  const old = now - CACHE_KEEP_REGISTRY_LEASE_MS - 1
  const files = {
    [`${process.pid}-live.json`]: old,
    'unidentifiable.json': old,
    '42-dead.json': old,
    '43-preboot.json': 1,
    '44-future.json': now + 1,
  }
  for (const [name, updatedAt] of Object.entries(files))
    await writeFile(
      join(directory, name),
      JSON.stringify(record(updatedAt, [session('s')])),
    )
  const registry = new CacheKeepSessionRegistry({
    directory,
    now: () => now,
    liveness: {
      pidAlive: (pid) => pid !== 42,
      incarnation: async () => null,
      now: () => now,
      uptime: () => 1000,
    },
  })
  expect(await registry.list()).toEqual([])
  expect((await readdir(directory)).sort()).toEqual(
    [
      `${process.pid}-live.json`,
      '44-future.json',
      'unidentifiable.json',
    ].sort(),
  )
})

test('registry publication uses the native owner-only file creation path on Windows', async () => {
  const directory = await makeDirectory()
  const created: string[] = []
  const verified: string[] = []
  const privateFiles = {
    verifySafeParent: async () => ({ ok: true }),
    verifyOwnerOnly: async (path: string) => {
      verified.push(path)
      return { ok: true }
    },
    readPrivateFile: readFile,
    createPrivateFile: async (path: string, bytes: string | Uint8Array) => {
      created.push(path)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    },
  } as unknown as OwnerOnlyOptions['privateFiles']
  const registry = new CacheKeepSessionRegistry({
    directory,
    instanceId: 'windows',
    ownerOnly: { platform: 'win32', privateFiles },
  })
  await registry.publish([session('s')])
  expect(created).toHaveLength(1)
  expect(created[0]).toStartWith(join(directory, 'windows.json.'))
  expect(created[0]).toEndWith('.tmp')
  expect(verified).toContain(directory)
  expect(await readdir(directory)).toEqual(['windows.json'])
})
