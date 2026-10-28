import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerOnlyOptions } from '../owner-only.ts'
import {
  createOwnerOnlyFile,
  defaultStateLayoutFs,
  writeOwnerOnlyExclusive,
} from '../state-layout-io.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function stagePath() {
  const root = await mkdtemp(join(tmpdir(), 'layout-io-'))
  roots.push(root)
  return join(root, 'config-dir.json.11111111-1111-4111-8111-111111111111.tmp')
}

function nativeWriter(
  createPrivateFile: NonNullable<
    NonNullable<OwnerOnlyOptions['privateFiles']>['createPrivateFile']
  >,
): NonNullable<OwnerOnlyOptions['privateFiles']> {
  return {
    verifyOwnerOnly: async () => ({ ok: true }),
    readPrivateFile: readFile,
    createPrivateFile,
  }
}

test('Windows owner-only stages write exact bytes through native creation without a second open', async () => {
  const path = await stagePath()
  const bytes = new Uint8Array([0, 0xff, 0xc3, 0x28, 0x80, 13, 10])
  const writes: { path: string; bytes: string | Uint8Array | undefined }[] = []
  const opens: unknown[][] = []
  const privateFiles = nativeWriter(async (path, bytes) => {
    writes.push({ path, bytes })
    await writeFile(path, bytes!, { flag: 'wx', mode: 0o600 })
  })
  await writeOwnerOnlyExclusive(path, bytes, 'win32', {
    ownership: { privateFiles },
    open: async (...args) => {
      opens.push(args)
      throw new Error('An owner-only stage must not be reopened')
    },
  })
  expect(writes).toHaveLength(1)
  expect(writes[0]?.path).toBe(path)
  expect(writes[0]?.bytes).toBe(bytes)
  expect(await readFile(path)).toEqual(Buffer.from(bytes))
  expect(opens).toEqual([])
})

test('a Windows native-create refusal propagates without truncating an existing stage or falling back to Node', async () => {
  const path = await stagePath()
  await writeFile(path, 'keep existing stage', { mode: 0o600 })
  let opens = 0
  const privateFiles = nativeWriter(async (path, bytes) => {
    await writeFile(path, bytes!, { flag: 'wx', mode: 0o600 })
  })
  await expect(
    writeOwnerOnlyExclusive(path, Buffer.from('replacement'), 'win32', {
      ownership: { privateFiles },
      open: async () => {
        opens++
        throw new Error('Native refusal must not fall back to Node')
      },
    }),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path, 'utf8')).toBe('keep existing stage')
  expect(opens).toBe(0)
})

test('a Windows native write or flush failure is not reported as a completed stage', async () => {
  const path = await stagePath()
  const failure = Object.assign(new Error('native flush failed'), {
    code: 'EIO',
  })
  let opens = 0
  const privateFiles = nativeWriter(async () => {
    throw failure
  })
  await expect(
    writeOwnerOnlyExclusive(path, Buffer.from('stage bytes'), 'win32', {
      ownership: { privateFiles },
      open: async () => {
        opens++
        throw new Error('Native write failure must not fall back to Node')
      },
    }),
  ).rejects.toBe(failure)
  expect(opens).toBe(0)
})

test('POSIX stage creation retains wx, mode 0600 and exact bytes without calling the Windows backend', async () => {
  const path = await stagePath()
  const bytes = Buffer.from([0, 0xff, 0x80, 13, 10])
  const opens: unknown[][] = []
  let nativeCreates = 0
  const options = {
    ownership: {
      privateFiles: nativeWriter(async () => {
        nativeCreates++
      }),
    },
    open: (async (...args) => {
      opens.push(args)
      return open(...args)
    }) as typeof open,
  }
  await writeOwnerOnlyExclusive(path, bytes, 'linux', options)
  expect(opens).toEqual([[path, 'wx', 0o600]])
  expect(await readFile(path)).toEqual(bytes)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  await expect(
    writeOwnerOnlyExclusive(path, Buffer.from('replacement'), 'linux', options),
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path)).toEqual(bytes)
  expect(nativeCreates).toBe(0)
})

test('createOwnerOnlyFile delegates the complete stage bytes to its filesystem writer', async () => {
  const path = await stagePath()
  const bytes = Buffer.from('stage bytes\n')
  const writes: unknown[][] = []
  await createOwnerOnlyFile(
    {
      ...defaultStateLayoutFs('win32'),
      createOwnerOnly: async (...args) => {
        writes.push(args)
      },
    },
    path,
    bytes,
  )
  expect(writes).toEqual([[path, bytes]])
})
