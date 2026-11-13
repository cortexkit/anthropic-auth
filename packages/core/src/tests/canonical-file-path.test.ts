import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalFilePath,
  canonicalFilePathSync,
} from '../canonical-file-path.ts'

const roots: string[] = []

async function fixture() {
  const root = await fsPromises.mkdtemp(join(tmpdir(), 'canonical-file-'))
  roots.push(root)
  return fsPromises.realpath(root)
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fsPromises.rm(root, { recursive: true, force: true })),
  )
})

for (const [name, canonical] of [
  ['async', (file: string) => canonicalFilePath(file, fsPromises)],
  ['sync', (file: string) => canonicalFilePathSync(file, fs)],
] as const) {
  test(`${name}: resolves ordinary and symlinked files and folders like realpath`, async () => {
    const root = await fixture()
    const folder = join(root, 'folder')
    await fsPromises.mkdir(folder)
    const file = join(folder, 'file.json')
    await fsPromises.writeFile(file, '{}')
    await fsPromises.symlink('folder', join(root, 'folder-alias'), 'dir')
    await fsPromises.symlink(
      'folder-alias/file.json',
      join(root, 'relative-link'),
    )
    await fsPromises.symlink(
      join(root, 'relative-link'),
      join(root, 'absolute-link'),
    )
    for (const path of [
      file,
      folder,
      join(root, 'folder-alias'),
      join(root, 'folder-alias/file.json'),
      join(root, 'relative-link'),
      join(root, 'absolute-link'),
    ]) {
      expect(await canonical(path)).toBe(await fsPromises.realpath(path))
    }
    expect(await canonical(join(root, 'folder-alias', 'missing.json'))).toBe(
      join(folder, 'missing.json'),
    )
    const deletedName = join(folder, 'file.json (deleted)')
    await fsPromises.writeFile(deletedName, '{}')
    expect(await canonical(deletedName)).toBe(deletedName)
  })

  test(`${name}: missing files resolve but dangling links and loops throw`, async () => {
    const root = await fixture()
    const missing = join(root, 'missing.json')
    expect(await canonical(missing)).toBe(missing)
    const link = join(root, 'link.json')
    await fsPromises.symlink('missing.json', link)
    await expect(
      Promise.resolve().then(() => canonical(link)),
    ).rejects.toHaveProperty('code', 'ENOENT')
    await fsPromises.rm(link)
    await fsPromises.symlink('other.json', link)
    await fsPromises.symlink('link.json', join(root, 'other.json'))
    await expect(
      Promise.resolve().then(() => canonical(link)),
    ).rejects.toHaveProperty('code', 'ELOOP')
  })

  test(`${name}: follows at most 40 file symlink hops`, async () => {
    const root = await fixture()
    const file = join(root, 'target.json')
    await fsPromises.writeFile(file, '{}')
    let target = 'target.json'
    for (let i = 0; i < 41; i++) {
      const link = `hop-${i}`
      await fsPromises.symlink(target, join(root, link))
      target = link
    }
    expect(await canonical(join(root, 'hop-39'))).toBe(file)
    await expect(
      Promise.resolve().then(() => canonical(join(root, 'hop-40'))),
    ).rejects.toHaveProperty('code', 'ELOOP')
  })
}

test('injected async and sync filesystems never realpath a replaceable leaf', async () => {
  const root = await fixture()
  const file = join(root, 'accounts.json')
  await fsPromises.writeFile(file, '{}')
  const asyncCalls: string[] = []
  const syncCalls: string[] = []
  expect(
    await canonicalFilePath(file, {
      ...fsPromises,
      realpath: async (path) => {
        asyncCalls.push(path)
        return path === file ? `${file} (deleted)` : fsPromises.realpath(path)
      },
    }),
  ).toBe(file)
  expect(
    canonicalFilePathSync(file, {
      ...fs,
      realpathSync: (path) => {
        syncCalls.push(path)
        return path === file ? `${file} (deleted)` : fs.realpathSync(path)
      },
    }),
  ).toBe(file)
  expect(asyncCalls).toEqual([root])
  expect(syncCalls).toEqual([root])
})
