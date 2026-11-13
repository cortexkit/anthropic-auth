import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { canonicalPath, resolveNativePoolPaths } from '../pool-paths.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-pool-paths-'))
  roots.push(root)
  return realpath(root)
}

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('derives an isolated namespace while preserving independent state directories', async () => {
  const root = await fixture()
  const config = join(root, 'config', 'anthropic-auth.json')
  const state = join(root, 'secrets', 'anthropic-auth-state.json')
  const paths = await resolveNativePoolPaths(config, state)
  expect(paths).toMatchObject({
    legacyConfig: config,
    legacyState: state,
    config: join(root, 'config', 'anthropic-auth-pool.json'),
    state: join(root, 'secrets', 'anthropic-auth-pool-state.json'),
    runtime: join(root, 'secrets', 'anthropic-auth-native-state.json'),
    journal: join(root, 'secrets', 'anthropic-auth-migration.json'),
    roster: join(root, 'secrets', 'anthropic-auth-custody-roster.json'),
  })
  expect(paths.storageId).toMatch(/^[a-f0-9]{64}$/)
  expect(await readdir(root)).toEqual([])
})

test('custom config and state names retain their respective namespaces', async () => {
  const root = await fixture()
  const paths = await resolveNativePoolPaths(
    join(root, 'project.json'),
    join(root, 'private', 'token.json'),
  )
  expect(paths.config).toBe(join(root, 'project.json.pool.json'))
  expect(paths.state).toBe(join(root, 'private', 'token.json.pool.json'))
  expect(paths.runtime).toBe(join(root, 'private', 'token.json.native.json'))
  expect(paths.journal).toBe(join(root, 'private', 'token.json.migration.json'))
  expect(paths.roster).toBe(join(root, 'private', 'token.json.roster.json'))
})

test('storage identity includes both paths and normalizes directory aliases', async () => {
  const root = await fixture()
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const changedConfig = await resolveNativePoolPaths(
    join(root, 'other.json'),
    paths.legacyState,
  )
  const changedState = await resolveNativePoolPaths(
    paths.legacyConfig,
    join(root, 'other-state.json'),
  )
  expect(changedConfig.storageId).not.toBe(paths.storageId)
  expect(changedState.storageId).not.toBe(paths.storageId)

  const aliasRoot = await fixture()
  const alias = join(aliasRoot, 'link')
  await symlink(root, alias, 'dir')
  const same = await resolveNativePoolPaths(
    join(alias, 'anthropic-auth.json'),
    join(alias, 'anthropic-auth-state.json'),
  )
  expect(same).toEqual(paths)
})

test('canonicalPath resolves directory aliases for existing and nonexistent leaves', async () => {
  const root = await fixture()
  const aliasRoot = await fixture()
  const alias = join(aliasRoot, 'link')
  await symlink(root, alias, 'dir')
  const existing = join(root, 'source.json')
  await writeFile(existing, '{}')
  expect(await canonicalPath(existing)).toBe(existing)
  expect(await canonicalPath(join(alias, 'source.json'))).toBe(existing)
  const missing = join(root, 'missing', 'nested', 'source.json')
  expect(await canonicalPath(missing)).toBe(missing)
  expect(
    await canonicalPath(join(alias, 'missing', 'nested', 'source.json')),
  ).toBe(missing)
  expect(await readdir(root)).toEqual(['source.json'])
})

test('canonicalPath never realpaths an atomically replaced file leaf', async () => {
  const root = await fixture()
  const file = join(root, 'accounts.json')
  await writeFile(file, '{}')
  const calls: string[] = []
  const result = await canonicalPath(file, {
    realpath: async (path) => {
      calls.push(path)
      const canonical = await realpath(path)
      return path === file ? `${canonical} (deleted)` : canonical
    },
  })
  expect(result).toBe(file)
  expect(calls).not.toContain(file)
})

test('Windows canonicalPath retains the configured realpath resolver', async () => {
  const calls: string[] = []
  expect(
    await canonicalPath('C:\\config\\accounts.json', {
      platform: 'win32',
      realpath: async (path) => {
        calls.push(path)
        return 'D:\\canonical\\accounts.json'
      },
    }),
  ).toBe('D:\\canonical\\accounts.json')
  expect(calls).toEqual(['C:\\config\\accounts.json'])
})

// The released resolver realpathed each leaf and walked parents on ENOENT.
// Keep this independent reference to protect persisted storage identities.
async function releasedCanonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  return join(await releasedCanonicalPath(parent), basename(absolute))
}

async function releasedPoolPaths(config: string, state: string) {
  const legacyConfig = await releasedCanonicalPath(config)
  const legacyState = await releasedCanonicalPath(state)
  const paths = {
    legacyConfig,
    legacyState,
    config: await releasedCanonicalPath(
      join(dirname(legacyConfig), 'anthropic-auth-pool.json'),
    ),
    state: await releasedCanonicalPath(
      join(dirname(legacyState), 'anthropic-auth-pool-state.json'),
    ),
    runtime: await releasedCanonicalPath(
      join(dirname(legacyState), 'anthropic-auth-native-state.json'),
    ),
    journal: await releasedCanonicalPath(
      join(dirname(legacyState), 'anthropic-auth-migration.json'),
    ),
    roster: await releasedCanonicalPath(
      join(dirname(legacyState), 'anthropic-auth-custody-roster.json'),
    ),
  }
  return {
    ...paths,
    storageId: createHash('sha256')
      .update(JSON.stringify(['anthropic', paths.config, paths.state]))
      .digest('hex'),
  }
}

test('pool paths and storageId equal the released resolver for files and symlink aliases', async () => {
  const root = await fixture()
  const folder = join(root, 'real')
  await mkdir(folder)
  const config = join(folder, 'anthropic-auth.json')
  const state = join(folder, 'anthropic-auth-state.json')
  const baseline = await resolveNativePoolPaths(config, state, {
    kind: 'legacy',
  })
  for (const [key, path] of Object.entries(baseline)) {
    if (key !== 'storageId') await writeFile(path, '{}')
  }
  await symlink(folder, join(root, 'folder-link'), 'dir')
  const links = join(root, 'file-links')
  await mkdir(links)
  await symlink(config, join(links, 'anthropic-auth.json'))
  await symlink(
    '../real/anthropic-auth-state.json',
    join(links, 'anthropic-auth-state.json'),
  )
  // The derived pool config can itself be a symlink, not just its account input.
  await writeFile(join(root, 'pool-target.json'), '{}')
  await rm(baseline.config)
  await symlink('../pool-target.json', baseline.config)
  for (const directory of [folder, join(root, 'folder-link'), links]) {
    const inputs = [
      join(directory, 'anthropic-auth.json'),
      join(directory, 'anthropic-auth-state.json'),
    ] as const
    expect(await resolveNativePoolPaths(...inputs, { kind: 'legacy' })).toEqual(
      await releasedPoolPaths(...inputs),
    )
  }
})

test('dangling account symlinks keep released paths and storageId; loops still refuse', async () => {
  const root = await fixture()
  const config = join(root, 'anthropic-auth.json')
  const state = join(root, 'anthropic-auth-state.json')
  await symlink('missing.json', config)
  expect(await canonicalPath(config)).toBe(await releasedCanonicalPath(config))
  expect(
    await resolveNativePoolPaths(config, state, { kind: 'legacy' }),
  ).toEqual(await releasedPoolPaths(config, state))
  await rm(config)
  await symlink('loop.json', config)
  await symlink('anthropic-auth.json', join(root, 'loop.json'))
  await expect(canonicalPath(config)).rejects.toHaveProperty('code', 'ELOOP')
  await expect(resolveNativePoolPaths(config, state)).rejects.toHaveProperty(
    'code',
    'ELOOP',
  )
})

test('refuses source or derived file collisions without creating a file', async () => {
  const root = await fixture()
  const config = join(root, 'anthropic-auth.json')
  await expect(resolveNativePoolPaths(config, config)).rejects.toThrow(
    'paths overlap',
  )
  await expect(
    resolveNativePoolPaths(config, join(root, 'anthropic-auth-pool.json')),
  ).rejects.toThrow('paths overlap')
  expect(await readdir(root)).toEqual([])
})

test('refuses a legacy config colliding with the derived roster without creating files', async () => {
  const root = await fixture()
  await expect(
    resolveNativePoolPaths(
      join(root, 'anthropic-auth-custody-roster.json'),
      join(root, 'anthropic-auth-state.json'),
    ),
  ).rejects.toThrow('paths overlap')
  await expect(
    resolveNativePoolPaths(
      join(root, 'token.json.roster.json'),
      join(root, 'token.json'),
    ),
  ).rejects.toThrow('paths overlap')
  expect(await readdir(root)).toEqual([])
})

test('refuses roster aliases of every source and native file', async () => {
  const root = await fixture()
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  for (const target of [
    paths.legacyConfig,
    paths.legacyState,
    paths.config,
    paths.state,
    paths.runtime,
    paths.journal,
  ]) {
    await writeFile(target, '{}')
    await symlink(target, paths.roster)
    await expect(
      resolveNativePoolPaths(paths.legacyConfig, paths.legacyState),
    ).rejects.toThrow('paths overlap')
    await rm(paths.roster)
    await rm(target)
  }
  expect(await readdir(root)).toEqual([])
})
