import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import {
  readNativeMigrationSource,
  requireUnchangedNativeMigrationSource,
} from '../migration-source.ts'

const roots: string[] = []

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-migration-source-')),
  )
  roots.push(root)
  return { root, path: join(root, 'source.json') }
}

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('captures exact bytes, filesystem ownership information and frozen nested import data', async () => {
  const { path } = await fixture()
  const text =
    ' { "anthropic": { "access": "synthetic-access", "labels": ["café 💻"] } }\n'
  await writeFile(path, text, { mode: 0o600 })
  const snapshot = await readNativeMigrationSource('hostAuth', path)
  expect(snapshot.digest).toBe(createHash('sha256').update(text).digest('hex'))
  expect(snapshot.data).toEqual({
    anthropic: { access: 'synthetic-access', labels: ['café 💻'] },
  })
  expect(
    snapshot.metadata?.mode ? snapshot.metadata.mode & 0o777 : undefined,
  ).toBe(0o600)
  expect(snapshot.metadata?.uid).toBe(process.getuid?.())
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain('synthetic-access')
  expect(inspect(snapshot)).not.toContain('synthetic-access')
  const auth = snapshot.data?.anthropic
  if (!auth || typeof auth !== 'object')
    throw new Error('Expected fixture auth object')
  expect(Object.isFrozen(auth)).toBe(true)
  expect(() => Object.assign(auth, { access: 'replaced' })).toThrow(TypeError)
  await requireUnchangedNativeMigrationSource(snapshot)
  expect(await readFile(path, 'utf8')).toBe(text)
})

test('records missing inputs distinctly and rejects an input that appears after capture', async () => {
  const { path } = await fixture()
  const snapshot = await readNativeMigrationSource('state', path)
  expect(snapshot).toMatchObject({
    digest: null,
    data: undefined,
    metadata: undefined,
  })
  await requireUnchangedNativeMigrationSource(snapshot)
  await writeFile(path, '{}', { mode: 0o600 })
  await expect(
    requireUnchangedNativeMigrationSource(snapshot),
  ).rejects.toMatchObject({ role: 'state', code: 'source-changed' })
})

test('malformed and non-object inputs never become the missing-entry path', async () => {
  const { path } = await fixture()
  for (const text of [
    '',
    '[]',
    'null',
    '"string"',
    '{"access":"synthetic-private-bearer"',
  ]) {
    await writeFile(path, text, { mode: 0o600 })
    let caught: unknown
    try {
      await readNativeMigrationSource('state', path)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'invalid-source' })
    expect(
      caught instanceof Error ? caught.message : String(caught),
    ).not.toContain('synthetic-private-bearer')
    expect(await readFile(path, 'utf8')).toBe(text)
  }
})

test('rejects malformed UTF-8 rather than changing a credential while decoding', async () => {
  const { path } = await fixture()
  const content = Buffer.concat([
    Buffer.from('{"access":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ])
  await writeFile(path, content, { mode: 0o600 })
  await expect(
    readNativeMigrationSource('hostAuth', path),
  ).rejects.toMatchObject({ code: 'invalid-source' })
  expect(await readFile(path)).toEqual(content)
})

test('rejects directories and symbolic links before reading any target bytes', async () => {
  const { root, path } = await fixture()
  await expect(readNativeMigrationSource('config', root)).rejects.toMatchObject(
    { code: 'unsafe-source' },
  )
  const target = join(root, 'target.json')
  await writeFile(target, '{"access":"synthetic-private-bearer"}', {
    mode: 0o600,
  })
  await symlink(target, path)
  let opened = false
  await expect(
    readNativeMigrationSource('hostAuth', path, {
      onOpened: async () => {
        opened = true
      },
    }),
  ).rejects.toMatchObject({ code: 'unsafe-source' })
  expect(opened).toBe(false)
})

test('refuses an atomic replacement after opening the original source', async () => {
  const { root, path } = await fixture()
  await writeFile(path, '{"account":"a"}', { mode: 0o600 })
  const replacement = join(root, 'replacement.json')
  await expect(
    readNativeMigrationSource('config', path, {
      onOpened: async () => {
        await writeFile(replacement, '{"account":"b"}', { mode: 0o600 })
        await rename(replacement, path)
      },
    }),
  ).rejects.toMatchObject({ code: 'source-changed' })
  expect(await readFile(path, 'utf8')).toBe('{"account":"b"}')
})

test('refuses an in-place source rewrite after opening it', async () => {
  const { path } = await fixture()
  await writeFile(path, '{"account":"a"}', { mode: 0o600 })
  await expect(
    readNativeMigrationSource('config', path, {
      onOpened: async () => {
        await writeFile(path, '{"account":"b"}')
      },
    }),
  ).rejects.toMatchObject({ code: 'source-changed' })
})

test('refuses deletion during a capture rather than treating it as initially missing', async () => {
  const { path } = await fixture()
  await writeFile(path, '{}', { mode: 0o600 })
  await expect(
    readNativeMigrationSource('state', path, {
      onOpened: async () => {
        await rm(path)
      },
    }),
  ).rejects.toMatchObject({ code: 'source-changed' })
})

test('revalidation detects unchanged-byte replacement, permission changes and deletion', async () => {
  const { root, path } = await fixture()
  await writeFile(path, '{}', { mode: 0o600 })
  const first = await readNativeMigrationSource('hostAuth', path)
  const replacement = join(root, 'replacement.json')
  await writeFile(replacement, '{}', { mode: 0o600 })
  await rename(replacement, path)
  await expect(
    requireUnchangedNativeMigrationSource(first),
  ).rejects.toMatchObject({ code: 'source-changed' })
  const second = await readNativeMigrationSource('hostAuth', path)
  await chmod(path, 0o640)
  await expect(
    requireUnchangedNativeMigrationSource(second),
  ).rejects.toMatchObject({ code: 'source-changed' })
  const third = await readNativeMigrationSource('hostAuth', path)
  await rm(path)
  await expect(
    requireUnchangedNativeMigrationSource(third),
  ).rejects.toMatchObject({ code: 'source-changed' })
})

test('bounds both an initially oversized input and growth during reading', async () => {
  const { path } = await fixture()
  const oversized = JSON.stringify({ padding: 'a'.repeat(4 * 1024 * 1024) })
  await writeFile(path, oversized, { mode: 0o600 })
  await expect(readNativeMigrationSource('config', path)).rejects.toMatchObject(
    { code: 'source-too-large' },
  )
  await writeFile(path, '{}')
  await expect(
    readNativeMigrationSource('config', path, {
      onOpened: async () => {
        await writeFile(path, oversized)
      },
    }),
  ).rejects.toMatchObject({ code: 'source-too-large' })
})
