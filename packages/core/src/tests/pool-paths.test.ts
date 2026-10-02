import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveNativePoolPaths } from '../pool-paths.ts'

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
