import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  type CacheKeepTarget,
  getHostDataHome,
  type LogTestRecord,
  type OwnerOnlyOptions,
} from '@cortexkit/anthropic-auth-core'
import {
  CacheKeepStore,
  cacheKeepStoreDirectory,
  legacyCacheKeepStoreDirectory,
} from '../v2/cachekeep-store'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(ownerOnly?: OwnerOnlyOptions) {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-store-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const store = new CacheKeepStore({ storageId: 'store', root, ownerOnly })
  const target: CacheKeepTarget = {
    id: 'private-session',
    bodyText: JSON.stringify({
      model: 'claude-sonnet-4-6',
      system: 'Cache me',
    }),
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      authorization: 'Bearer SECRET-access',
      'x-api-key': 'SECRET-key',
      cookie: 'SECRET-cookie',
    },
    bodyBytes: 50,
    cacheExpiresAt: Date.now() + 3600_000,
    nextPrewarmAt: Date.now() + 3300_000,
    consecutiveFailures: 0,
    dayKey: 'always',
    oauthAccountIdentity: 'opaque-identity',
    isSubagent: false,
  }
  const saved = async () => {
    const [file] = await readdir(store.directory)
    return JSON.parse(
      gunzipSync(await readFile(join(store.directory, file!))).toString(),
    )
  }
  return { root, store, target, saved }
}

test('restart storage defaults to a hashed private data folder, never the config folder', () => {
  const path = cacheKeepStoreDirectory('../../config/my-account')
  expect(dirname(path)).toBe(
    join(getHostDataHome(), 'cortexkit', 'anthropic-auth', 'cachekeep-restore'),
  )
  expect(basename(path)).toMatch(/^[a-f0-9]{16}$/)
  expect(path).not.toContain('my-account')
  expect(cacheKeepStoreDirectory('another-account')).not.toBe(path)
})

test('restart files exclude headers and credential fields, use gzip and owner-only modes', async () => {
  const f = await fixture()
  f.target.bodyText = JSON.stringify({
    model: 'claude-sonnet-4-6',
    system: 'Cache me',
    authorization: 'SECRET-auth',
    'x-api-key': 'SECRET-key',
    cookie: 'SECRET-cookie',
    access_token: 'SECRET-token',
    refreshToken: 'SECRET-refresh',
  })
  expect(f.store.changed(f.target)).toBeUndefined()
  await f.store.drain()
  const [name] = await readdir(f.store.directory)
  expect(name).toMatch(/^[a-f0-9]{64}\.json\.gz$/)
  const bytes = await readFile(join(f.store.directory, name!))
  expect([...bytes.subarray(0, 2)]).toEqual([31, 139])
  const text = gunzipSync(bytes).toString()
  expect(text).not.toMatch(
    /authorization|x-api-key|cookie|token|SECRET|headers/,
  )
  expect(JSON.parse((await f.saved()).bodyText).system).toBe('Cache me')
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises')
    expect((await stat(f.store.directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(f.store.directory, name!))).mode & 0o777).toBe(
      0o600,
    )
  }
})

test('restart storage does not redact tool schemas or change ordinary cached body bytes', async () => {
  const f = await fixture()
  f.target.bodyText =
    '{ "tools": [{ "name": "http", "input_schema": { "properties": { "headers": { "type": "object" }, "token": { "type": "string" } } } }], "system": "Cache me" }'
  f.store.changed(f.target)
  await f.store.drain()
  expect((await f.saved()).bodyText).toBe(f.target.bodyText)
})

test('restart writes coalesce the latest body and drain includes later tool steps', async () => {
  const f = await fixture()
  f.store.changed(f.target)
  f.target.bodyText = '{"system":"latest before flush"}'
  f.store.changed(f.target)
  await f.store.drain()
  expect((await f.saved()).bodyText).toContain('latest before flush')
  f.target.bodyText = '{"system":"later tool step"}'
  f.store.changed(f.target)
  await f.store.drain()
  expect((await f.saved()).bodyText).toContain('later tool step')
})

test('a replacement restart store drains the old pending body before loading or writing', async () => {
  const f = await fixture()
  f.store.changed(f.target)
  const next = new CacheKeepStore({ storageId: 'store', root: f.root }, f.store)
  const restored: string[] = []
  await next.load(Date.now(), (entry) => {
    restored.push(entry.bodyText)
    return true
  })
  expect(restored).toEqual([f.target.bodyText])
  const newest = '{"system":"Written by the newer store"}'
  next.changed({ ...f.target, bodyText: newest })
  await next.drain()
  expect((await f.saved()).bodyText).toBe(newest)
})

test('removal and policy-off cancel queued writes without resurrecting a file', async () => {
  const f = await fixture()
  f.store.changed(f.target)
  f.store.removed(f.target.id)
  await f.store.drain()
  expect(await readdir(f.store.directory)).toEqual([])
  f.store.changed(f.target)
  await f.store.drain()
  expect(await readdir(f.store.directory)).toHaveLength(1)
  f.store.changed({ ...f.target, bodyText: '{"system":"new body"}' })
  f.store.clear()
  await f.store.drain()
  expect(await readdir(f.store.directory)).toEqual([])
})

test.skipIf(process.platform === 'win32')(
  'unsafe or symlinked restart folders are refused with one WARN, never repaired',
  async () => {
    const f = await fixture()
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))
    cleanups.push(() => __setLogTestSink(null))
    await mkdir(f.store.directory, { recursive: true, mode: 0o755 })
    await f.store.load(Date.now(), () => true)
    f.store.changed(f.target)
    await f.store.drain()
    await f.store.load(Date.now(), () => true)
    expect(logs.filter((log) => log.level === 'warn')).toHaveLength(1)
    expect(await readdir(f.store.directory)).toEqual([])

    const other = new CacheKeepStore({
      storageId: 'symlink-store',
      root: f.root,
    })
    await symlink(f.store.directory, other.directory)
    await other.load(Date.now(), () => true)
    other.changed(f.target)
    await other.drain()
    expect(logs.filter((log) => log.level === 'warn')).toHaveLength(2)
    expect(await readdir(f.store.directory)).toEqual([])
  },
)

test('the Windows path creates the directory and file with native owner-only ACL helpers', async () => {
  const createdDirectories: string[] = []
  const createdFiles: string[] = []
  const verified: string[] = []
  const privateFiles = {
    verifySafeParent: async () => ({ ok: true }),
    verifyOwnerOnly: async (path: string) => {
      verified.push(path)
      return { ok: true }
    },
    readPrivateFile: readFile,
    createPrivateDirectory: async (path: string) => {
      createdDirectories.push(path)
      await mkdir(path, { mode: 0o700 })
    },
    createPrivateFile: async (path: string, bytes: Uint8Array) => {
      createdFiles.push(path)
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    },
  } as unknown as OwnerOnlyOptions['privateFiles']
  const f = await fixture({ platform: 'win32', privateFiles })
  f.store.changed(f.target)
  await f.store.drain()
  expect(createdDirectories).toEqual([
    join(f.root, 'cortexkit'),
    join(f.root, 'cortexkit', 'anthropic-auth'),
    join(f.root, 'cortexkit', 'anthropic-auth', 'cachekeep-restore'),
    f.store.directory,
  ])
  expect(createdFiles).toHaveLength(1)
  expect(createdFiles[0]).toStartWith(f.store.directory)
  expect(verified).toContain(f.store.directory)
  const restored: string[] = []
  await f.store.load(Date.now(), (entry) => {
    restored.push(entry.id)
    return true
  })
  expect(restored).toEqual([f.target.id])
})

test('an empty data store restores the old temp folder once and retires loaded files', async () => {
  const f = await fixture()
  f.store.changed(f.target)
  await f.store.drain()
  const legacy = legacyCacheKeepStoreDirectory('store', f.root)
  await rename(f.store.directory, legacy)
  const next = new CacheKeepStore({ storageId: 'store', root: f.root })
  const ids: string[] = []
  await next.load(Date.now(), (entry) => {
    ids.push(entry.id)
    return true
  })
  expect(ids).toEqual([f.target.id])
  expect(await readdir(legacy)).toEqual([])
  expect(await readdir(next.directory)).toHaveLength(1)
  await rm(next.directory, { recursive: true })
  await rename(legacy, next.directory)
  // A new old-folder file appearing later cannot resurrect a removed session.
  f.store.changed({ ...f.target, id: 'late' })
  await f.store.drain()
  await rename(next.directory, legacy)
  await next.load(Date.now(), () => {
    throw new Error('must not load old folder twice')
  })
  expect(await readdir(next.directory)).toEqual([])
  expect(await readdir(legacy)).toHaveLength(1)
})

test('a nonempty data store wins over old temp restart records', async () => {
  const f = await fixture()
  f.store.changed(f.target)
  await f.store.drain()
  const legacy = legacyCacheKeepStoreDirectory('store', f.root)
  await mkdir(legacy, { mode: 0o700 })
  await writeFile(join(legacy, 'unreadable.json.gz'), 'old')
  const ids: string[] = []
  await f.store.load(Date.now(), (entry) => {
    ids.push(entry.id)
    return true
  })
  expect(ids).toEqual([f.target.id])
  expect(await readdir(legacy)).toEqual(['unreadable.json.gz'])
})

test('warm reservations bypass coalescing and cannot be overwritten by an older queued count', async () => {
  const f = await fixture()
  f.target.policyState = {
    ownerSessionId: f.target.id,
    planned: true,
    lastRealRequestAt: Date.now(),
    warmsSinceLastRealRequest: 22,
    warmCostSoFar: 0.01,
    prefixTokens: 1000,
    inputTokens: 1100,
    hasWarmed: true,
  }
  f.store.changed(f.target)
  f.target.policyState.warmsSinceLastRealRequest = 23
  expect(await f.store.reserveWarm(f.target)).toBe(true)
  expect((await f.saved()).policyState.warmsSinceLastRealRequest).toBe(23)
  await f.store.drain()
  expect((await f.saved()).policyState).toMatchObject({
    warmsSinceLastRealRequest: 23,
    prefixTokens: 1000,
    hasWarmed: true,
  })
  const replacement = new CacheKeepStore(
    { storageId: 'store', root: f.root },
    f.store,
  )
  const counts: number[] = []
  await replacement.load(Date.now(), (entry) => {
    counts.push(entry.policyState!.warmsSinceLastRealRequest)
    return true
  })
  expect(counts).toEqual([23])
})

test.each([
  'warmsSinceLastRealRequest',
  'warmCostSoFar',
  'lastRealRequestAt',
] as const)(
  'invalid restart policy state %s is not replayed',
  async (field) => {
    const f = await fixture()
    f.target.policyState = {
      ownerSessionId: f.target.id,
      planned: true,
      lastRealRequestAt: Date.now(),
      warmsSinceLastRealRequest: 0,
      warmCostSoFar: 0,
      hasWarmed: false,
    }
    f.target.policyState[field] =
      field === 'lastRealRequestAt' ? Date.now() + 60_000 : -1
    f.store.changed(f.target)
    await f.store.drain()
    let restored = 0
    await f.store.load(Date.now(), () => {
      restored++
      return true
    })
    expect(restored).toBe(0)
    expect(await readdir(f.store.directory)).toEqual([])
  },
)

test('a transient private reservation write failure does not turn enabled persistence into memory-only mode', async () => {
  let failWrites = false
  const privateFiles = {
    verifySafeParent: async () => ({ ok: true }),
    verifyOwnerOnly: async () => ({ ok: true }),
    readPrivateFile: readFile,
    createPrivateDirectory: async (path: string) => {
      await mkdir(path, { mode: 0o700 })
    },
    createPrivateFile: async (path: string, bytes: Uint8Array) => {
      if (failWrites) throw new Error('synthetic write failure')
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    },
  } as unknown as OwnerOnlyOptions['privateFiles']
  const f = await fixture({ platform: 'win32', privateFiles })
  f.target.policyState = {
    ownerSessionId: f.target.id,
    planned: true,
    lastRealRequestAt: Date.now(),
    warmsSinceLastRealRequest: 0,
    warmCostSoFar: 0,
    hasWarmed: false,
  }
  f.store.changed(f.target)
  await f.store.drain()
  failWrites = true
  f.target.policyState.warmsSinceLastRealRequest = 1
  expect(await f.store.reserveWarm(f.target)).toBe(false)
  expect((await f.saved()).policyState.warmsSinceLastRealRequest).toBe(0)
  failWrites = false
  f.target.policyState.warmsSinceLastRealRequest = 2
  expect(await f.store.reserveWarm(f.target)).toBe(true)
  expect((await f.saved()).policyState.warmsSinceLastRealRequest).toBe(2)
})
