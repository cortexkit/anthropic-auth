import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  __setCustodyManifestLockTestOptions,
  __setLogTestSink,
  CUSTODY_MANIFEST_LOCK_TTL_MS,
  CustodyHandleManifestReader,
  custodyCredentialId,
  readCustodyHandles,
  removeCustodyHandleManifestEntry,
  resolveCustodyHandle,
  withCustodyManifestLock,
  writeCustodyHandleManifestEntry,
} from '@cortexkit/anthropic-auth-core'

import { loadGoldenCustodyManifest } from './custody-handle-manifest.fixture.ts'

const { text: fixtureText, manifest: fixture } =
  await loadGoldenCustodyManifest()

async function withTempDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'custody-manifest-test-'))
  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function withManifest<T>(
  content: string,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  return withTempDirectory(async (directory) => {
    const parent = join(directory, 'manifest')
    const path = join(parent, 'handles.json')
    await fs.mkdir(parent)
    await fs.chmod(parent, 0o700)
    await fs.writeFile(path, content)
    await fs.chmod(path, 0o600)
    await fs.lstat(path)
    return callback(path)
  })
}

function reader(path: string, expectedUid?: number) {
  return new CustodyHandleManifestReader({
    path,
    provider: 'anthropic',
    serve: 'anthropic-auth',
    expectedUid,
  })
}

const writerHandle = `ckh_${'D'.repeat(43)}`
const replacementWriterHandle = `ckh_${'E'.repeat(43)}`
const writerEntry = {
  label: 'writer',
  handle: writerHandle,
  credentialId: 'oauth:anthropic:writer',
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function temporaryFiles(parent: string): Promise<string[]> {
  return fs
    .readdir(parent)
    .then((names) => names.filter((name) => name.endsWith('.tmp')))
}

async function expectInvalid(
  result: Promise<Awaited<ReturnType<CustodyHandleManifestReader['read']>>>,
  reason: string,
): Promise<void> {
  const value = await result
  expect(value.status).toBe('invalid')
  if (value.status !== 'invalid') throw new Error('expected invalid manifest')
  expect(value.reason).toBe(reason)
}

async function expectIgnored(
  result: Promise<Awaited<ReturnType<CustodyHandleManifestReader['read']>>>,
  reason: 'foreign-serve' | 'missing-provider',
): Promise<void> {
  const value = await result
  expect(value.status).toBe('ignored')
  if (value.status !== 'ignored') throw new Error('expected ignored manifest')
  expect(value.reason).toBe(reason)
}

function withProvider(
  mutate: (provider: Record<string, unknown>) => void,
): string {
  const value = structuredClone(fixture) as {
    version: number
    providers: Array<Record<string, unknown>>
  }
  const provider = value.providers.find(
    (entry) => entry.provider === 'anthropic',
  )
  if (!provider) throw new Error('missing anthropic fixture')
  mutate(provider)
  return JSON.stringify(value)
}

afterEach(() => {
  mock.restore()
})

describe('CustodyHandleManifestReader', () => {
  test('reads the version 1 anthropic-auth manifest and ignores other providers', async () => {
    await withManifest(fixtureText, async (path) => {
      const result = await reader(path).read()
      expect(result.status).toBe('ready')
      if (result.status !== 'ready') throw new Error('expected ready manifest')
      expect(result.manifest).toMatchObject({
        version: 1,
        provider: 'anthropic',
        serve: 'anthropic-auth',
      })
      expect(result.manifest.accounts).toHaveLength(1)
    })
  })

  test('ignores an anthropic block with a foreign serve', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.serve = 'foreign-serve'
      }),
      async (path) => {
        await expectIgnored(reader(path).read(), 'foreign-serve')
      },
    )
  })

  test('ignores a manifest without an anthropic block', async () => {
    const value = structuredClone(fixture) as typeof fixture
    value.providers = value.providers.filter(
      (provider) => provider.provider !== 'anthropic',
    )
    await withManifest(JSON.stringify(value), async (path) => {
      await expectIgnored(reader(path).read(), 'missing-provider')
    })
  })

  test('rejects reserved account labels without inheriting prototype keys', () => {
    const source = Object.assign(
      Object.create({ providers: fixture.providers }),
      { version: 1 },
    ) as Record<string, unknown>
    expect(() =>
      readCustodyHandles(source, 'anthropic', 'anthropic-auth'),
    ).toThrow('missing manifest providers')

    for (const label of ['__proto__', 'constructor', 'prototype']) {
      expect(() =>
        readCustodyHandles(
          JSON.parse(
            withProvider((provider) => {
              provider.accounts = [
                { ...fixture.providers[1]?.accounts[0], label },
              ]
            }),
          ),
          'anthropic',
          'anthropic-auth',
        ),
      ).toThrow('invalid account label')
    }
  })

  test('rejects invalid labels with a fixed reason', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], label: 'Bad' },
        ]
      }),
      async (path) => {
        await expect(reader(path).read()).resolves.toEqual({
          status: 'invalid',
          reason: 'invalid account label',
        })
      },
    )
  })

  test('builds the canonical OAuth credential id from a custody label', () => {
    expect(custodyCredentialId('work-alt')).toBe('oauth:anthropic:work-alt')
    expect(() => custodyCredentialId('not a label')).toThrow('invalid-label')
  })

  test('rejects invalid handles with a fixed reason', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], handle: 'invalid' },
        ]
      }),
      async (path) => {
        await expect(reader(path).read()).resolves.toMatchObject({
          status: 'ready',
          manifest: {
            accounts: [],
            corruptLabels: new Set(['work-alt']),
          },
        })
      },
    )
  })

  test('collects validated superseded handles into a set', async () => {
    const legacyHandle = fixture.providers[0]?.accounts[1]?.superseded?.[0]
    if (typeof legacyHandle !== 'string')
      throw new Error('missing fixture handle')
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], superseded: [legacyHandle] },
        ]
      }),
      async (path) => {
        const result = await reader(path).read()
        expect(result.status).toBe('ready')
        if (result.status !== 'ready')
          throw new Error('expected ready manifest')
        expect(result.manifest.superseded.size).toBe(1)
        expect(result.manifest.superseded.has(legacyHandle)).toBe(true)
      },
    )
  })

  test('rejects a symlink', async () => {
    await withTempDirectory(async (directory) => {
      const target = join(directory, 'target.json')
      const path = join(directory, 'handles.json')
      await fs.writeFile(target, fixtureText)
      await fs.chmod(target, 0o600)
      await fs.symlink(target, path)
      await expectInvalid(reader(path).read(), 'manifest is a symlink')
    })
  })

  test('rejects a non-regular manifest path', async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, 'handles.json')
      await fs.mkdir(path)
      await expectInvalid(reader(path).read(), 'manifest is not a regular file')
    })
  })

  test('rejects a manifest with a mode other than 0600', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(path, 0o644)
      await expectInvalid(reader(path).read(), 'manifest mode must be 0600')
    })
  })

  test('rejects a manifest with restrictive but non-0600 mode', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(path, 0o400)
      await fs.lstat(path)
      await expectInvalid(reader(path).read(), 'manifest mode must be 0600')
    })
  })

  test('opens a validated manifest with O_NOFOLLOW', async () => {
    await withManifest(fixtureText, async (path) => {
      const openSpy = spyOn(fs, 'open')

      await expect(reader(path).read()).resolves.toMatchObject({
        status: 'ready',
      })

      const [, flags] = openSpy.mock.calls[0] ?? []
      expect((Number(flags) & fsConstants.O_NOFOLLOW) !== 0).toBe(true)
    })
  })

  test('rejects a manifest owned by a different uid', async () => {
    await withManifest(fixtureText, async (path) => {
      await expectInvalid(
        reader(path, (process.getuid?.() ?? 0) + 1).read(),
        'manifest owner does not match',
      )
    })
  })

  test('rejects a parent directory owned by a different uid', async () => {
    await withManifest(fixtureText, async (path) => {
      const parent = dirname(path)
      const originalLstat = fs.lstat
      spyOn(fs, 'lstat').mockImplementation(async (target) => {
        const stats = await originalLstat(target)
        if (target !== parent) return stats
        return Object.assign(Object.create(stats), {
          uid: (process.getuid?.() ?? 0) + 1,
        })
      })
      await expectInvalid(
        reader(path).read(),
        'manifest parent owner does not match',
      )
    })
  })

  test('rejects a world-writable parent directory without sticky mode', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(dirname(path), 0o777)
      await expectInvalid(
        reader(path).read(),
        'manifest parent is world-writable',
      )
    })
  })

  test('rejects a group-writable parent directory without sticky mode', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(dirname(path), 0o770)
      await expectInvalid(
        reader(path).read(),
        'manifest parent is group-writable',
      )
    })
  })

  test('accepts a private manifest parent directory', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(dirname(path), 0o700)
      await expect(reader(path).read()).resolves.toMatchObject({
        status: 'ready',
      })
    })
  })

  test('accepts a sticky group-writable manifest parent directory', async () => {
    await withManifest(fixtureText, async (path) => {
      const parent = dirname(path)
      const originalLstat = fs.lstat
      spyOn(fs, 'lstat').mockImplementation(async (target) => {
        const stats = await originalLstat(target)
        if (target !== parent) return stats
        return Object.assign(Object.create(stats), {
          mode: 0o1770,
        })
      })
      await expect(reader(path).read()).resolves.toMatchObject({
        status: 'ready',
      })
    })
  })

  test('rejects a manifest larger than 256 KiB', async () => {
    await withManifest('x'.repeat(256 * 1024 + 1), async (path) => {
      await expectInvalid(reader(path).read(), 'manifest exceeds maximum size')
    })
  })

  test('returns absent for a missing manifest', async () => {
    await withTempDirectory(async (directory) => {
      await expect(
        reader(join(directory, 'missing.json')).read(),
      ).resolves.toEqual({
        status: 'absent',
      })
    })
  })

  test('redacts malformed JSON source bytes', async () => {
    const bareToken = `ckh_${'A'.repeat(43)}`
    await withManifest(`{"version":1, ${bareToken}}`, async (path) => {
      const result = await reader(path).read()
      expect(result.status).toBe('invalid')
      if (result.status !== 'invalid')
        throw new Error('expected invalid manifest')
      expect(result.reason === 'invalid JSON').toBe(true)
      expect(result.reason.includes(bareToken)).toBe(false)
    })
  })

  test('keys parsed-content cache hits to validated descriptor metadata', async () => {
    await withManifest(fixtureText, async (path) => {
      const originalLstat = fs.lstat
      const originalOpen = fs.open
      const readSpies: Array<ReturnType<typeof spyOn>> = []
      let manifestLstatCalls = 0
      spyOn(fs, 'lstat').mockImplementation(async (target) => {
        const stats = await originalLstat(target)
        if (target !== path || ++manifestLstatCalls !== 2) return stats
        return Object.assign(Object.create(stats), {
          mtimeMs: stats.mtimeMs + 1,
        })
      })
      const openSpy = spyOn(fs, 'open').mockImplementation(
        async (...arguments_) => {
          const handle = await originalOpen(...arguments_)
          readSpies.push(spyOn(handle, 'read'))
          return handle
        },
      )
      const manifestReader = reader(path)
      await expect(manifestReader.read()).resolves.toMatchObject({
        status: 'ready',
      })
      await expect(manifestReader.read()).resolves.toMatchObject({
        status: 'ready',
      })
      expect(openSpy).toHaveBeenCalledTimes(2)
      expect(readSpies.flatMap((readSpy) => readSpy.mock.calls)).toHaveLength(1)

      await fs.chmod(path, 0o644)
      await expectInvalid(manifestReader.read(), 'manifest mode must be 0600')
      expect(openSpy).toHaveBeenCalledTimes(2)
    })
  })
})

describe('writeCustodyHandleManifestEntry', () => {
  afterEach(() => __setCustodyManifestLockTestOptions())

  test('refuses an entry that the manifest reader would reject', async () => {
    await withTempDirectory(async (directory) => {
      const parent = join(directory, 'manifest')
      const path = join(parent, 'handles.json')
      await fs.mkdir(parent)
      await fs.chmod(parent, 0o700)

      await expect(
        writeCustodyHandleManifestEntry({
          path,
          entry: {
            label: 'Work',
            handle: writerHandle,
            credentialId: 'oauth:anthropic:Work',
          },
        }),
      ).resolves.toEqual({ status: 'refused', reason: 'invalid entry' })
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  test('refuses a valid-shaped credential id that is not canonical for its label', async () => {
    await withTempDirectory(async (directory) => {
      const parent = join(directory, 'manifest')
      const path = join(parent, 'handles.json')
      await fs.mkdir(parent)
      await fs.chmod(parent, 0o700)

      await expect(
        writeCustodyHandleManifestEntry({
          path,
          entry: { ...writerEntry, credentialId: 'oauth:anthropic:other' },
        }),
      ).resolves.toEqual({ status: 'refused', reason: 'invalid entry' })
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  test('refuses dangling and resolved manifest symlinks without replacing them', async () => {
    for (const target of ['missing-target.json', 'real-target.json']) {
      await withTempDirectory(async (directory) => {
        const parent = join(directory, 'manifest')
        const path = join(parent, 'handles.json')
        await fs.mkdir(parent)
        await fs.chmod(parent, 0o700)
        if (target === 'real-target.json')
          await fs.writeFile(join(parent, target), fixtureText)
        await fs.symlink(target, path)

        await expect(
          writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toEqual({
          status: 'refused',
          reason: 'manifest is a symlink',
        })
        expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
        expect(await fs.readlink(path)).toBe(target)
      })
    }
  })

  test('round-trips foreign provider blocks without changing their serialized JSON', async () => {
    await withManifest(fixtureText, async (path) => {
      const before = fixture.providers
        .filter(
          (provider) =>
            provider.provider !== 'anthropic' ||
            provider.serve !== 'anthropic-auth',
        )
        .map(serialize)

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'written',
      })

      const after = JSON.parse(
        await fs.readFile(path, 'utf8'),
      ) as typeof fixture
      expect(
        after.providers
          .filter(
            (provider) =>
              provider.provider !== 'anthropic' ||
              provider.serve !== 'anthropic-auth',
          )
          .map(serialize),
      ).toEqual(before)
    })
  })

  test('preserves an oddly formatted foreign block structurally', async () => {
    const foreign = {
      provider: 'deepseek',
      serve: 'opencode-claustrum',
      accounts: [],
      retained: { z: 0, a: [true, false] },
    }
    const input = ` { "providers" : [ { "retained" : { "z" : 0 , "a" : [ true , false ] }, "accounts" : [ ], "serve" : "opencode-claustrum", "provider" : "deepseek" } ], "version" : 1 } `
    await withManifest(input, async (path) => {
      await writeCustodyHandleManifestEntry({ path, entry: writerEntry })
      const output = JSON.parse(await fs.readFile(path, 'utf8')) as {
        providers: Array<Record<string, unknown>>
      }
      expect(output.providers[0]).toEqual(foreign)
      expect(JSON.parse(await fs.readFile(path, 'utf8'))).toBeDefined()
    })
  })

  test('replaces a corrupt own-label entry with a canonical binding', async () => {
    await withManifest(
      serialize({
        version: 1,
        providers: [
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: [
              {
                label: writerEntry.label,
                handle: writerHandle,
                credential_id: writerEntry.credentialId,
                superseded: 'corrupt',
              },
            ],
          },
        ],
      }),
      async (path) => {
        await expect(
          writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toEqual({ status: 'written' })
        const output = JSON.parse(await fs.readFile(path, 'utf8')) as {
          providers: Array<{ accounts: Array<Record<string, unknown>> }>
        }
        expect(output.providers[0]?.accounts).toEqual([
          {
            label: writerEntry.label,
            handle: writerEntry.handle,
            credential_id: writerEntry.credentialId,
          },
        ])
      },
    )
  })

  test('inserts our entry into an absent manifest file', async () => {
    await withTempDirectory(async (directory) => {
      const parent = join(directory, 'manifest')
      const path = join(parent, 'handles.json')
      await fs.mkdir(parent)
      await fs.chmod(parent, 0o700)

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'written',
      })
      expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({
        version: 1,
        providers: [
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: [
              {
                label: writerEntry.label,
                handle: writerEntry.handle,
                credential_id: writerEntry.credentialId,
              },
            ],
          },
        ],
      })
    })
  })

  test('adds our block when no anthropic-auth block exists', async () => {
    const input = {
      version: 1,
      providers: [
        {
          provider: 'deepseek',
          serve: 'opencode-claustrum',
          accounts: [],
        },
      ],
    }
    await withManifest(serialize(input), async (path) => {
      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'written',
      })
      const output = JSON.parse(await fs.readFile(path, 'utf8')) as typeof input
      expect(output.providers).toHaveLength(2)
      expect(output.providers[1]).toMatchObject({
        provider: 'anthropic',
        serve: 'anthropic-auth',
      })
    })
  })

  test('replaces a matching label without creating a second entry', async () => {
    await withManifest(fixtureText, async (path) => {
      await expect(
        writeCustodyHandleManifestEntry({
          path,
          entry: {
            ...writerEntry,
            label: 'work-alt',
            handle: replacementWriterHandle,
            credentialId: custodyCredentialId('work-alt'),
          },
        }),
      ).resolves.toEqual({ status: 'written' })

      const output = JSON.parse(
        await fs.readFile(path, 'utf8'),
      ) as typeof fixture
      const ours = output.providers.find(
        (provider) =>
          provider.provider === 'anthropic' &&
          provider.serve === 'anthropic-auth',
      )
      expect(
        ours?.accounts.filter((entry) => entry.label === 'work-alt'),
      ).toEqual([
        {
          label: 'work-alt',
          handle: replacementWriterHandle,
          credential_id: 'oauth:anthropic:work-alt',
        },
      ])
    })
  })

  test('leaves bytes, mtime, and temporary files unchanged for an idempotent entry', async () => {
    await withManifest(fixtureText, async (path) => {
      await writeCustodyHandleManifestEntry({ path, entry: writerEntry })
      const before = await fs.readFile(path, 'utf8')
      const beforeStats = await fs.lstat(path)

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'unchanged',
      })

      expect(await fs.readFile(path, 'utf8')).toBe(before)
      expect((await fs.lstat(path)).mtimeMs).toBe(beforeStats.mtimeMs)
      expect(await temporaryFiles(dirname(path))).toEqual([])
    })
  })

  test('preserves a foreign anthropic serve while adding our anthropic-auth block', async () => {
    const foreign = {
      provider: 'anthropic',
      serve: 'foreign-serve',
      accounts: [
        { label: 'foreign', handle: writerHandle, credential_id: 'foreign:id' },
      ],
    }
    await withManifest(
      serialize({ version: 1, providers: [foreign] }),
      async (path) => {
        await writeCustodyHandleManifestEntry({ path, entry: writerEntry })

        const output = JSON.parse(await fs.readFile(path, 'utf8')) as {
          providers: Array<Record<string, unknown>>
        }
        expect(output.providers).toHaveLength(2)
        expect(serialize(output.providers[0])).toBe(serialize(foreign))
        expect(output.providers[1]).toMatchObject({
          provider: 'anthropic',
          serve: 'anthropic-auth',
        })
      },
    )
  })

  test('refuses unowned and unsafe parent directories without writing', async () => {
    await withTempDirectory(async (directory) => {
      const parent = join(directory, 'manifest')
      const path = join(parent, 'handles.json')
      await fs.mkdir(parent)
      await fs.chmod(parent, 0o777)

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'refused',
        reason: 'manifest parent is world-writable',
      })
      expect(await temporaryFiles(parent)).toEqual([])
      await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })

      await fs.chmod(parent, 0o700)
      await expect(
        writeCustodyHandleManifestEntry({
          path,
          entry: writerEntry,
          expectedUid: (process.getuid?.() ?? 0) + 1,
        }),
      ).resolves.toEqual({
        status: 'refused',
        reason: 'manifest parent owner does not match',
      })
      expect(await temporaryFiles(parent)).toEqual([])
    })
  })

  test('refuses an entry whose serialized manifest would exceed 256 KiB', async () => {
    const padding = 'x'.repeat(256 * 1024 - 250)
    await withManifest(
      serialize({
        version: 1,
        providers: [
          {
            provider: 'deepseek',
            serve: 'opencode-claustrum',
            accounts: [],
            padding,
          },
        ],
      }),
      async (path) => {
        const before = await fs.readFile(path, 'utf8')
        await expect(
          writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toEqual({
          status: 'refused',
          reason: 'manifest exceeds maximum size',
        })
        expect(await fs.readFile(path, 'utf8')).toBe(before)
        expect(await temporaryFiles(dirname(path))).toEqual([])
      },
    )
  })

  test('keeps the original target intact when rename fails during atomic publication', async () => {
    await withManifest(fixtureText, async (path) => {
      const before = await fs.readFile(path, 'utf8')
      spyOn(fs, 'rename').mockRejectedValue(
        Object.assign(new Error('rename failed'), { code: 'EIO' }),
      )

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'refused',
        reason: 'unreadable (EIO)',
      })

      expect(await fs.readFile(path, 'utf8')).toBe(before)
      expect(await temporaryFiles(dirname(path))).toEqual([])
    })
  })

  test('publishes through a temporary file in its lock directory and leaves no temporary files', async () => {
    await withManifest(fixtureText, async (path) => {
      const originalRename = fs.rename
      const renamedFrom: string[] = []
      spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === path) renamedFrom.push(String(from))
        return originalRename(from, to)
      })

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({ status: 'written' })

      expect(renamedFrom).toHaveLength(1)
      expect(dirname(renamedFrom[0] ?? '')).toBe(`${path}.lock`)
      expect(await temporaryFiles(dirname(path))).toEqual([])
      await expect(fs.lstat(`${path}.lock`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  test.serial(
    "an evicted writer's rename fails and cannot overwrite the successor's manifest",
    async () => {
      await withManifest(fixtureText, async (path) => {
        const lockPath = `${path}.lock`
        const originalNow = Date.now
        const beforeRename = Promise.withResolvers<void>()
        const resumeA = Promise.withResolvers<void>()
        let now = 0
        let aNonce: string | undefined
        let pauseA = true
        Date.now = () => now
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
          beforeRename: async () => {
            if (!pauseA) return
            pauseA = false
            aNonce = JSON.parse(
              await fs.readFile(join(lockPath, 'owner'), 'utf8'),
            ).nonce
            beforeRename.resolve()
            await resumeA.promise
          },
        })
        try {
          const a = writeCustodyHandleManifestEntry({
            path,
            entry: writerEntry,
          })
          await beforeRename.promise

          now = 101
          const successorEntry = {
            ...writerEntry,
            handle: replacementWriterHandle,
          }
          await expect(
            writeCustodyHandleManifestEntry({ path, entry: successorEntry }),
          ).resolves.toEqual({ status: 'written' })
          resumeA.resolve()
          await expect(a).resolves.toEqual({
            status: 'refused',
            reason: 'manifest lock renewal failed; write aborted',
            code: 'renewal_failed',
          })
          expect(await fs.readFile(path, 'utf8')).toContain(
            replacementWriterHandle,
          )
          expect(await fs.readFile(path, 'utf8')).not.toContain(writerHandle)
          expect(aNonce).toBeDefined()
          await expect(
            fs.lstat(`${lockPath}.stale-0-${aNonce}/manifest.${aNonce}.tmp`),
          ).resolves.toBeDefined()
          await expect(fs.lstat(`${path}.tmp`)).rejects.toMatchObject({
            code: 'ENOENT',
          })
        } finally {
          resumeA.resolve()
          Date.now = originalNow
        }
      })
    },
  )

  test.serial('aborts publication after a renewal failure', async () => {
    await withManifest(fixtureText, async (path) => {
      const before = await fs.readFile(path, 'utf8')
      const lockPath = `${path}.lock`
      const ownerPath = join(lockPath, 'owner')
      const originalOpen = fs.open
      const originalRename = fs.rename
      let ownerRenames = 0
      __setCustodyManifestLockTestOptions({
        ttlMs: 100,
        retryMinMs: 5,
        retryMaxMs: 5,
        renewalIntervalMs: 10,
      })
      spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === ownerPath && ++ownerRenames > 1)
          throw Object.assign(new Error('renewal failed'), { code: 'EIO' })
        return originalRename(from, to)
      })
      spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        if (
          String(args[0]).endsWith('.tmp') &&
          String(args[0]).startsWith(`${lockPath}/`)
        ) {
          await Bun.sleep(40)
        }
        return handle
      })

      await expect(
        writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toEqual({
        status: 'refused',
        reason: 'manifest lock renewal failed; write aborted',
        code: 'renewal_failed',
      })
      expect(await fs.readFile(path, 'utf8')).toBe(before)
      expect(await temporaryFiles(dirname(path))).toEqual([])
    })
  })

  test.serial(
    'aborts publication when a successor replaces its lock',
    async () => {
      await withManifest(fixtureText, async (path) => {
        const before = await fs.readFile(path, 'utf8')
        const lockPath = `${path}.lock`
        const ownerPath = join(lockPath, 'owner')
        const stalePath = `${lockPath}.stale-0-foreign`
        const originalOpen = fs.open
        const originalRename = fs.rename
        const successorClaimed = Promise.withResolvers<void>()
        let scheduledSuccessor = false
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 5,
          retryMaxMs: 5,
          renewalIntervalMs: 1_000,
        })
        spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          const result = await originalRename(from, to)
          if (String(to) === ownerPath && !scheduledSuccessor) {
            scheduledSuccessor = true
            setTimeout(() => {
              void (async () => {
                await originalRename(lockPath, stalePath)
                await fs.mkdir(lockPath, { mode: 0o700 })
                await fs.writeFile(
                  ownerPath,
                  `${JSON.stringify({
                    tenant: 'foreign-tenant',
                    pid: process.pid,
                    claimed_at_ms: Date.now(),
                    nonce: 'foreign-nonce',
                  })}\n`,
                )
                successorClaimed.resolve()
              })().catch(successorClaimed.reject)
            }, 5)
          }
          return result
        })
        spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await originalOpen(...args)
          if (
            String(args[0]).endsWith('.tmp') &&
            String(args[0]).startsWith(`${lockPath}/`)
          ) {
            await Bun.sleep(40)
          }
          return handle
        })

        await expect(
          writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toEqual({
          status: 'refused',
          reason: 'manifest lock renewal failed; write aborted',
          code: 'renewal_failed',
        })
        await successorClaimed.promise
        expect(await fs.readFile(path, 'utf8')).toBe(before)
        expect(await temporaryFiles(dirname(path))).toEqual([])
        expect(JSON.parse(await fs.readFile(ownerPath, 'utf8'))).toMatchObject({
          nonce: 'foreign-nonce',
        })
      })
    },
  )

  test('opens a 0600 temporary file before atomically writing a 0600 target', async () => {
    await withManifest(fixtureText, async (path) => {
      const originalOpen = fs.open
      const openSpy = spyOn(fs, 'open').mockImplementation(originalOpen)

      await writeCustodyHandleManifestEntry({ path, entry: writerEntry })

      const temporaryOpen = openSpy.mock.calls.find(([target]) =>
        String(target).endsWith('.tmp'),
      )
      const [, flags, mode] = temporaryOpen ?? []
      expect((Number(flags) & fsConstants.O_CREAT) !== 0).toBe(true)
      expect((Number(flags) & fsConstants.O_EXCL) !== 0).toBe(true)
      expect((Number(flags) & fsConstants.O_WRONLY) !== 0).toBe(true)
      expect(mode).toBe(0o600)
      expect(Number((await fs.lstat(path)).mode) & 0o777).toBe(0o600)
    })
  })

  test('redacts handle bytes from refusal reasons', async () => {
    const canary = `ckh_${'F'.repeat(43)}`
    await withManifest(`{"version":1,"${canary}":`, async (path) => {
      const result = await writeCustodyHandleManifestEntry({
        path,
        entry: writerEntry,
      })
      expect(result.status).toBe('refused')
      if (result.status !== 'refused')
        throw new Error('expected writer refusal')
      expect(result.reason.includes(canary)).toBe(false)
    })
  })

  test('preserves existing superseded data without writing it for a replacement', async () => {
    const superseded = `ckh_${'G'.repeat(43)}`
    await withManifest(
      serialize({
        version: 1,
        providers: [
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: [
              {
                label: writerEntry.label,
                handle: writerHandle,
                credential_id: writerEntry.credentialId,
                superseded: [superseded],
              },
            ],
          },
        ],
      }),
      async (path) => {
        await writeCustodyHandleManifestEntry({
          path,
          entry: { ...writerEntry, handle: replacementWriterHandle },
        })

        const output = JSON.parse(await fs.readFile(path, 'utf8')) as {
          providers: Array<{ accounts: Array<Record<string, unknown>> }>
        }
        expect(output.providers[0]?.accounts).toEqual([
          {
            label: writerEntry.label,
            handle: replacementWriterHandle,
            credential_id: writerEntry.credentialId,
            superseded: [superseded],
          },
        ])
      },
    )
  })
})

describe('removeCustodyHandleManifestEntry', () => {
  afterEach(() => __setCustodyManifestLockTestOptions())

  test('removes our entry while preserving a foreign tenant block byte-identically', async () => {
    const foreign = {
      provider: 'deepseek',
      serve: 'opencode-claustrum',
      accounts: [
        { label: 'foreign', handle: writerHandle, credential_id: 'foreign:id' },
      ],
      retained: { z: 0, a: [true, false] },
    }
    await withManifest(
      serialize({
        version: 1,
        providers: [
          foreign,
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: [
              {
                label: writerEntry.label,
                handle: writerEntry.handle,
                credential_id: writerEntry.credentialId,
              },
            ],
          },
        ],
      }),
      async (path) => {
        const beforeForeign = serialize(foreign)
        await expect(
          removeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toBe('removed')
        const output = JSON.parse(await fs.readFile(path, 'utf8')) as {
          providers: Array<Record<string, unknown>>
        }
        expect(serialize(output.providers[0])).toBe(beforeForeign)
        expect(output.providers[1]).toEqual({
          provider: 'anthropic',
          serve: 'anthropic-auth',
          accounts: [],
        })
      },
    )
  })

  test('returns missing when our entry is absent', async () => {
    await withManifest(fixtureText, async (path) => {
      await expect(
        removeCustodyHandleManifestEntry({ path, entry: writerEntry }),
      ).resolves.toBe('missing')
    })
  })

  test('removes every duplicate of our manifest entry', async () => {
    const account = {
      label: writerEntry.label,
      handle: writerEntry.handle,
      credential_id: writerEntry.credentialId,
    }
    await withManifest(
      serialize({
        version: 1,
        providers: [
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: [account, account],
          },
        ],
      }),
      async (path) => {
        await expect(
          removeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toBe('removed')
        const output = JSON.parse(await fs.readFile(path, 'utf8')) as {
          providers: Array<{ accounts: unknown[] }>
        }
        expect(output.providers[0]?.accounts).toEqual([])
      },
    )
  })

  test.serial(
    'returns refused when the lease is lost before rename',
    async () => {
      await withManifest(fixtureText, async (path) => {
        await writeCustodyHandleManifestEntry({ path, entry: writerEntry })
        const before = await fs.readFile(path, 'utf8')
        const lockPath = `${path}.lock`
        const ownerPath = join(lockPath, 'owner')
        const originalOpen = fs.open
        const originalRename = fs.rename
        let ownerRenames = 0
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 5,
          retryMaxMs: 5,
          renewalIntervalMs: 10,
        })
        spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (String(to) === ownerPath && ++ownerRenames > 1)
            throw Object.assign(new Error('renewal failed'), { code: 'EIO' })
          return originalRename(from, to)
        })
        spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await originalOpen(...args)
          if (
            String(args[0]).endsWith('.tmp') &&
            String(args[0]).startsWith(`${lockPath}/`)
          ) {
            await Bun.sleep(40)
          }
          return handle
        })

        await expect(
          removeCustodyHandleManifestEntry({ path, entry: writerEntry }),
        ).resolves.toBe('refused')
        expect(await fs.readFile(path, 'utf8')).toBe(before)
      })
    },
  )
})

describe('withCustodyManifestLock', () => {
  afterEach(() => {
    __setCustodyManifestLockTestOptions()
  })

  test.serial(
    'evicts an owner that crashes after the contender starts',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        const ownerPath = join(lockPath, 'owner')
        const ttlMs = 2_000
        const crashedOwnerNonce = 'crashed-owner'
        const originalNow = Date.now
        let now = 0
        let ownerReads = 0
        Date.now = () => now
        __setCustodyManifestLockTestOptions({
          ttlMs,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
          afterStaleOwnerRead: () => {
            ownerReads += 1
            now = ownerReads === 1 ? ttlMs + 1 : ttlMs + 500
          },
        })
        try {
          await fs.mkdir(lockPath, { mode: 0o700 })
          await fs.writeFile(
            ownerPath,
            `${JSON.stringify({
              tenant: 'anthropic-auth',
              pid: process.pid,
              claimed_at_ms: now,
              nonce: crashedOwnerNonce,
            })}\n`,
          )
          now = 500

          expect(
            await withCustodyManifestLock(path, async () => 'acquired'),
          ).toBe('acquired')
          await expect(
            fs.lstat(`${lockPath}.stale-0-${crashedOwnerNonce}`),
          ).resolves.toBeDefined()
        } finally {
          Date.now = originalNow
        }
      })
    },
  )

  test.serial(
    'evicts stale owners whose nonces use widened cross-version alphabets',
    async () => {
      for (const nonce of ['abc.def', 'AAAA====']) {
        await withTempDirectory(async (directory) => {
          const path = join(directory, 'handles.json')
          const lockPath = `${path}.lock`
          const claimedAtMs = Date.now() - 31
          await fs.mkdir(lockPath, { mode: 0o700 })
          await fs.writeFile(
            join(lockPath, 'owner'),
            `${JSON.stringify({
              tenant: 'future-tenant',
              pid: process.pid,
              claimed_at_ms: claimedAtMs,
              nonce,
            })}\n`,
          )
          __setCustodyManifestLockTestOptions({
            ttlMs: 30,
            retryMinMs: 1,
            retryMaxMs: 1,
            renewalIntervalMs: 1_000,
          })

          await expect(
            withCustodyManifestLock(path, async () => 'acquired'),
          ).resolves.toBe('acquired')
          await expect(
            fs.lstat(`${lockPath}.stale-${claimedAtMs}-${nonce}`),
          ).resolves.toBeDefined()
        })
      }
    },
  )

  test.serial(
    'evicts a stale owner record with an unknown future key',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        const originalNow = Date.now
        let now = 0
        Date.now = () => now
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
        })
        try {
          await fs.mkdir(lockPath, { mode: 0o700 })
          await fs.writeFile(
            join(lockPath, 'owner'),
            `${JSON.stringify({
              tenant: 'future-tenant',
              pid: process.pid,
              claimed_at_ms: now,
              nonce: 'future-owner',
              future_field: 1,
            })}\n`,
          )
          now = 101
          await expect(
            withCustodyManifestLock(path, async () => 'acquired'),
          ).resolves.toBe('acquired')
          await expect(
            fs.lstat(`${lockPath}.stale-0-future-owner`),
          ).resolves.toBeDefined()
        } finally {
          Date.now = originalNow
        }
      })
    },
  )

  test.serial(
    'rejects unsafe stale owner nonce filenames without constructing quarantine targets',
    async () => {
      const unsafeNonces = [
        ['empty', ''],
        ['too long', 'a'.repeat(129)],
        ['slash', '../escaped'],
        ['backslash', 'a\\b'],
        ['NUL', 'a\0b'],
        ['C0 control', 'a\u001fb'],
        ['DEL control', 'a\u007fb'],
        ['dot', '.'],
        ['dot dot', '..'],
        ['colon', 'a:b'],
        ['asterisk', 'a*b'],
        ['question mark', 'a?b'],
        ['quote', 'a"b'],
        ['less than', 'a<b'],
        ['greater than', 'a>b'],
        ['pipe', 'a|b'],
      ] as const

      await withTempDirectory(async (directory) => {
        const manifestDirectory = join(directory, 'manifest')
        await fs.mkdir(manifestDirectory)
        const originalRename = fs.rename
        const staleRenameTargets: string[] = []
        spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (String(from).endsWith('.lock'))
            staleRenameTargets.push(String(to))
          return originalRename(from, to)
        })
        __setCustodyManifestLockTestOptions({
          ttlMs: 30,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
        })

        for (const [index, [, nonce]] of unsafeNonces.entries()) {
          const path = join(manifestDirectory, `handles-${index}.json`)
          const lockPath = `${path}.lock`
          await fs.mkdir(lockPath, { mode: 0o700 })
          await fs.writeFile(
            join(lockPath, 'owner'),
            `${JSON.stringify({
              tenant: 'future-tenant',
              pid: process.pid,
              claimed_at_ms: Date.now() - 31,
              nonce,
            })}\n`,
          )
          staleRenameTargets.length = 0

          await expect(
            withCustodyManifestLock(path, async () => 'acquired'),
          ).rejects.toMatchObject({ code: 'owner_invalid' })
          expect(staleRenameTargets).toEqual([])
          await expect(fs.lstat(lockPath)).resolves.toBeDefined()
          await expect(
            fs.lstat(join(directory, 'escaped')),
          ).rejects.toMatchObject({
            code: 'ENOENT',
          })
        }
      })
    },
  )

  test.serial(
    'rejects trailing Windows nonce aliases before quarantine',
    async () => {
      for (const nonce of ['alias.', 'alias ']) {
        await withTempDirectory(async (directory) => {
          const path = join(directory, 'handles.json')
          const lockPath = `${path}.lock`
          const originalRename = fs.rename
          const staleRenameTargets: string[] = []
          await fs.mkdir(lockPath, { mode: 0o700 })
          await fs.writeFile(
            join(lockPath, 'owner'),
            `${JSON.stringify({
              tenant: 'future-tenant',
              pid: process.pid,
              claimed_at_ms: Date.now() - 31,
              nonce,
            })}\n`,
          )
          __setCustodyManifestLockTestOptions({
            ttlMs: 30,
            retryMinMs: 1,
            retryMaxMs: 1,
            renewalIntervalMs: 1_000,
          })
          spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(from) === lockPath) staleRenameTargets.push(String(to))
            return originalRename(from, to)
          })
          try {
            await expect(
              withCustodyManifestLock(path, async () => 'acquired'),
            ).rejects.toMatchObject({ code: 'owner_invalid' })
            expect(staleRenameTargets).toEqual([])
            await expect(fs.lstat(lockPath)).resolves.toBeDefined()
          } finally {
            mock.restore()
          }
        })
      }
    },
  )

  test.serial(
    'does not evict a holder whose owner record is renewed across multiple leases',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const originalNow = Date.now
        const originalSetInterval = globalThis.setInterval
        const originalClearInterval = globalThis.clearInterval
        let now = 0
        let renew: (() => void) | undefined
        Date.now = () => now
        globalThis.setInterval = ((handler: () => void) => {
          renew = handler
          return {} as ReturnType<typeof setInterval>
        }) as typeof setInterval
        globalThis.clearInterval = (() => {}) as typeof clearInterval
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 5,
          retryMaxMs: 5,
          renewalIntervalMs: 30,
        })
        const order: string[] = []
        const firstEntered = Promise.withResolvers<void>()
        const releaseFirst = Promise.withResolvers<void>()
        const first = withCustodyManifestLock(path, async () => {
          order.push('first-enter')
          firstEntered.resolve()
          await releaseFirst.promise
          order.push('first-exit')
        })
        await firstEntered.promise
        for (now = 30; now <= 300; now += 30) {
          renew?.()
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        now = 350
        const second = withCustodyManifestLock(path, async () => {
          order.push('second-enter')
        })

        try {
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(order).toEqual(['first-enter'])
          releaseFirst.resolve()
          await Promise.all([first, second])
          expect(order).toEqual(['first-enter', 'first-exit', 'second-enter'])
        } finally {
          Date.now = originalNow
          globalThis.setInterval = originalSetInterval
          globalThis.clearInterval = originalClearInterval
        }
      })
    },
  )

  test.serial(
    'does not remove a successor lock after its own expired lease is evicted',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 5,
          retryMaxMs: 5,
          renewalIntervalMs: 1_000,
        })
        const firstEntered = Promise.withResolvers<void>()
        const releaseFirst = Promise.withResolvers<void>()
        const secondEntered = Promise.withResolvers<void>()
        const releaseSecond = Promise.withResolvers<void>()
        const first = withCustodyManifestLock(path, async () => {
          firstEntered.resolve()
          await releaseFirst.promise
        })
        await firstEntered.promise
        await Bun.sleep(130)
        const second = withCustodyManifestLock(path, async () => {
          secondEntered.resolve()
          await releaseSecond.promise
        })
        await secondEntered.promise

        releaseFirst.resolve()
        await first
        await expect(fs.lstat(lockPath)).resolves.toBeDefined()
        releaseSecond.resolve()
        await second
      })
    },
  )

  test.serial(
    'keeps an expired owner lock for the next claimant to evict',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        const originalNow = Date.now
        let now = 0
        const logs: Array<{
          level?: string
          channel?: string
          message?: string
          payload?: Record<string, unknown>
        }> = []
        Date.now = () => now
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 5,
          retryMaxMs: 5,
          renewalIntervalMs: 1_000,
        })
        __setLogTestSink((record) => logs.push(record))
        try {
          await withCustodyManifestLock(path, async () => {
            now = 101
          })
          await expect(fs.lstat(lockPath)).resolves.toBeDefined()
          expect(logs).toContainEqual({
            level: 'warn',
            channel: 'claustrum',
            message: 'manifest lock lease lost, not releasing',
            payload: { id: path },
          })

          await withCustodyManifestLock(path, async () => {})
          await expect(fs.lstat(lockPath)).rejects.toMatchObject({
            code: 'ENOENT',
          })
        } finally {
          __setLogTestSink(null)
          Date.now = originalNow
        }
      })
    },
  )

  test.serial(
    'reports a corrupt owner record at the deadline without evicting it',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        const owner = 'not json'
        await fs.mkdir(lockPath, { mode: 0o700 })
        await fs.writeFile(join(lockPath, 'owner'), owner)
        __setCustodyManifestLockTestOptions({
          ttlMs: 30,
          retryMinMs: 5,
          retryMaxMs: 5,
          renewalIntervalMs: 1_000,
        })

        await expect(
          withCustodyManifestLock(path, async () => 'acquired'),
        ).rejects.toMatchObject({ code: 'owner_invalid' })
        expect(await fs.lstat(lockPath)).toBeDefined()
        expect(await fs.readFile(join(lockPath, 'owner'), 'utf8')).toBe(owner)
      })
    },
  )

  test.serial('keeps a missing owner record as lock_busy', async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, 'handles.json')
      const lockPath = `${path}.lock`
      await fs.mkdir(lockPath, { mode: 0o700 })
      __setCustodyManifestLockTestOptions({
        ttlMs: 30,
        retryMinMs: 5,
        retryMaxMs: 5,
        renewalIntervalMs: 1_000,
      })

      await expect(
        withCustodyManifestLock(path, async () => 'acquired'),
      ).rejects.toMatchObject({ code: 'lock_busy' })
      await expect(fs.lstat(lockPath)).resolves.toBeDefined()
      await expect(fs.lstat(join(lockPath, 'owner'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  test.serial('reports a held lock as lock_busy', async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, 'handles.json')
      const firstEntered = Promise.withResolvers<void>()
      const releaseFirst = Promise.withResolvers<void>()
      __setCustodyManifestLockTestOptions({
        ttlMs: 30,
        retryMinMs: 1,
        retryMaxMs: 1,
        renewalIntervalMs: 5,
      })
      const first = withCustodyManifestLock(path, async () => {
        firstEntered.resolve()
        await releaseFirst.promise
      })
      try {
        await firstEntered.promise
        await expect(
          withCustodyManifestLock(path, async () => 'acquired'),
        ).rejects.toMatchObject({ code: 'lock_busy' })
      } finally {
        releaseFirst.resolve()
        await first
      }
    })
  })

  test.serial(
    'aborts before rename with renewal_failed and preserves manifest bytes',
    async () => {
      await withManifest(fixtureText, async (path) => {
        const before = await fs.readFile(path, 'utf8')
        const originalNow = Date.now
        const originalOpen = fs.open
        let now = 0
        Date.now = () => now
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
        })
        spyOn(fs, 'open').mockImplementation(async (...arguments_) => {
          const handle = await originalOpen(...arguments_)
          if (dirname(String(arguments_[0])) === dirname(path)) now = 101
          return handle
        })
        try {
          await expect(
            writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
          ).resolves.toMatchObject({
            status: 'refused',
            code: 'renewal_failed',
          })
          expect(await fs.readFile(path, 'utf8')).toBe(before)
        } finally {
          Date.now = originalNow
        }
      })
    },
  )

  test.serial(
    'keeps a post-commit lease loss non-throwing after the write lands',
    async () => {
      await withManifest(fixtureText, async (path) => {
        const originalNow = Date.now
        const originalRename = fs.rename
        let now = 0
        Date.now = () => now
        __setCustodyManifestLockTestOptions({
          ttlMs: 100,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
        })
        spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          const result = await originalRename(from, to)
          if (String(to) === path) now = 101
          return result
        })
        try {
          await expect(
            writeCustodyHandleManifestEntry({ path, entry: writerEntry }),
          ).resolves.toEqual({ status: 'written' })
          expect(await fs.readFile(path, 'utf8')).toContain(writerHandle)
        } finally {
          Date.now = originalNow
        }
      })
    },
  )

  test.serial(
    'does not let a delayed stale evictor quarantine a fresh successor lease',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        const ownerPath = join(lockPath, 'owner')
        const staleClaimedAtMs = Date.now() - 1_001
        const staleNonce = 'stale-owner'
        const originalRename = fs.rename
        const bObservedStaleOwner = Promise.withResolvers<void>()
        const releaseBObservation = Promise.withResolvers<void>()
        const bRenameOutcome = Promise.withResolvers<'failed' | 'succeeded'>()
        const aEntered = Promise.withResolvers<void>()
        const releaseA = Promise.withResolvers<void>()
        const bEntered = Promise.withResolvers<void>()
        const releaseB = Promise.withResolvers<void>()
        let pausedB = false
        let staleRenameAttempts = 0
        __setCustodyManifestLockTestOptions({
          ttlMs: 1_000,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
          afterStaleOwnerRead: async () => {
            if (pausedB) return
            pausedB = true
            bObservedStaleOwner.resolve()
            await releaseBObservation.promise
          },
        })
        await fs.mkdir(lockPath, { mode: 0o700 })
        await fs.writeFile(
          ownerPath,
          `${JSON.stringify({
            tenant: 'anthropic-auth',
            pid: process.pid,
            claimed_at_ms: staleClaimedAtMs,
            nonce: staleNonce,
          })}\n`,
        )
        spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          const isStaleRename =
            String(from) === lockPath &&
            String(to).startsWith(`${lockPath}.stale-`)
          if (!isStaleRename) return originalRename(from, to)
          staleRenameAttempts += 1
          try {
            const result = await originalRename(from, to)
            if (staleRenameAttempts === 2) bRenameOutcome.resolve('succeeded')
            return result
          } catch (error) {
            if (staleRenameAttempts === 2) bRenameOutcome.resolve('failed')
            throw error
          }
        })

        const b = withCustodyManifestLock(path, async () => {
          bEntered.resolve()
          await releaseB.promise
        })
        let a: Promise<void> | undefined
        try {
          await bObservedStaleOwner.promise
          a = withCustodyManifestLock(path, async () => {
            aEntered.resolve()
            await releaseA.promise
          })
          await aEntered.promise
          const aOwner = JSON.parse(await fs.readFile(ownerPath, 'utf8'))
          releaseBObservation.resolve()
          expect(await bRenameOutcome.promise).toBe('failed')
          expect(
            JSON.parse(await fs.readFile(ownerPath, 'utf8')),
          ).toMatchObject({ nonce: aOwner.nonce })
          releaseA.resolve()
          await a
          await bEntered.promise
        } finally {
          releaseBObservation.resolve()
          releaseA.resolve()
          releaseB.resolve()
          await Promise.allSettled([a, b].filter(Boolean))
        }
      })
    },
  )

  test.serial(
    'quarantines competing stale evictors under their observed owner nonce',
    async () => {
      await withTempDirectory(async (directory) => {
        const path = join(directory, 'handles.json')
        const lockPath = `${path}.lock`
        const ownerPath = join(lockPath, 'owner')
        const staleClaimedAtMs = Date.now() - 1_001
        const staleNonce = 'same-stale-owner'
        const expectedQuarantine = `${lockPath}.stale-${staleClaimedAtMs}-${staleNonce}`
        const expectedQuarantineName = basename(expectedQuarantine)
        const originalRename = fs.rename
        const bObservedStaleOwner = Promise.withResolvers<void>()
        const releaseBObservation = Promise.withResolvers<void>()
        const bReadyToRename = Promise.withResolvers<void>()
        const releaseBRename = Promise.withResolvers<void>()
        const aEntered = Promise.withResolvers<void>()
        const releaseA = Promise.withResolvers<void>()
        const bEntered = Promise.withResolvers<void>()
        const releaseB = Promise.withResolvers<void>()
        let pausedB = false
        let staleRenameAttempts = 0
        __setCustodyManifestLockTestOptions({
          ttlMs: 1_000,
          retryMinMs: 1,
          retryMaxMs: 1,
          renewalIntervalMs: 1_000,
          afterStaleOwnerRead: async () => {
            if (pausedB) return
            pausedB = true
            bObservedStaleOwner.resolve()
            await releaseBObservation.promise
          },
        })
        await fs.mkdir(lockPath, { mode: 0o700 })
        await fs.writeFile(
          ownerPath,
          `${JSON.stringify({
            tenant: 'anthropic-auth',
            pid: process.pid,
            claimed_at_ms: staleClaimedAtMs,
            nonce: staleNonce,
          })}\n`,
        )
        spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          const isStaleRename =
            String(from) === lockPath &&
            String(to).startsWith(`${lockPath}.stale-`)
          if (isStaleRename) staleRenameAttempts += 1
          if (staleRenameAttempts === 2) {
            bReadyToRename.resolve()
            await releaseBRename.promise
          }
          return originalRename(from, to)
        })

        const b = withCustodyManifestLock(path, async () => {
          bEntered.resolve()
          await releaseB.promise
        })
        let a: Promise<void> | undefined
        try {
          await bObservedStaleOwner.promise
          a = withCustodyManifestLock(path, async () => {
            aEntered.resolve()
            await releaseA.promise
          })
          await aEntered.promise
          releaseBObservation.resolve()
          await bReadyToRename.promise
          expect(
            (await fs.readdir(directory)).filter((name) =>
              name.startsWith(`${basename(lockPath)}.stale-`),
            ),
          ).toEqual([expectedQuarantineName])
          releaseBRename.resolve()
          releaseA.resolve()
          await a
          await bEntered.promise
        } finally {
          releaseBObservation.resolve()
          releaseBRename.resolve()
          releaseA.resolve()
          releaseB.resolve()
          await Promise.allSettled([a, b].filter(Boolean))
        }
      })
    },
  )

  test('pins renewal cadence within one third of the lease', async () => {
    const core = (await import('@cortexkit/anthropic-auth-core')) as {
      CUSTODY_MANIFEST_LOCK_RENEW_MS?: number
    }
    expect(core.CUSTODY_MANIFEST_LOCK_RENEW_MS).toBeDefined()
    expect(
      (core.CUSTODY_MANIFEST_LOCK_RENEW_MS ?? Infinity) * 3,
    ).toBeLessThanOrEqual(CUSTODY_MANIFEST_LOCK_TTL_MS)
  })
})

describe('resolveCustodyHandle', () => {
  const activeHandle = `ckh_${'A'.repeat(43)}`
  const legacyHandle = `ckh_${'B'.repeat(43)}`
  const otherHandle = `ckh_${'C'.repeat(43)}`

  function account(
    input: { id?: string; label?: string; claustrumHandle?: string } = {},
  ) {
    return {
      id: input.id ?? 'uuid-not-a-label',
      type: 'oauth' as const,
      refresh: 'refresh-token',
      ...input,
    }
  }

  function manifest(input: { accounts?: Array<Record<string, unknown>> } = {}) {
    const parsed = readCustodyHandles(
      {
        version: 1,
        providers: [
          {
            provider: 'anthropic',
            serve: 'anthropic-auth',
            accounts: input.accounts ?? [
              {
                label: 'alice',
                handle: activeHandle,
                credential_id: 'oauth:anthropic:alice',
              },
            ],
          },
        ],
      },
      'anthropic',
      'anthropic-auth',
    )
    return {
      version: 1 as const,
      provider: 'anthropic' as const,
      serve: 'anthropic-auth' as const,
      accounts: parsed.accounts,
      superseded: parsed.superseded,
    }
  }

  function expectResolvedSource(
    result: ReturnType<typeof resolveCustodyHandle>,
    source: 'manifest' | 'legacy',
  ) {
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved')
      throw new Error('expected resolved handle')
    expect(result.source).toBe(source)
  }

  function expectUnresolvedReason(
    result: ReturnType<typeof resolveCustodyHandle>,
    reason:
      | 'missing-label'
      | 'invalid-label'
      | 'duplicate-label'
      | 'missing-entry'
      | 'foreign-serve'
      | 'superseded',
  ) {
    expect(result.status).toBe('unresolved')
    if (result.status !== 'unresolved')
      throw new Error('expected unresolved handle')
    expect(result.reason).toBe(reason)
  }

  test('prefers a matching manifest handle over a legacy handle', () => {
    const result = resolveCustodyHandle({
      account: account({ label: 'alice', claustrumHandle: legacyHandle }),
      manifest: manifest(),
    })

    expectResolvedSource(result, 'manifest')
  })

  test('falls back to legacy only when a valid label has no manifest entry', () => {
    const result = resolveCustodyHandle({
      account: account({ label: 'bob', claustrumHandle: legacyHandle }),
      manifest: manifest(),
    })

    expectResolvedSource(result, 'legacy')
  })

  test('falls back to legacy when the reader rejects an invalid manifest', async () => {
    await withManifest('{', async (path) => {
      const result = await reader(path).read()
      expect(result.status).toBe('invalid')

      expectResolvedSource(
        resolveCustodyHandle({
          account: account({ label: 'alice', claustrumHandle: legacyHandle }),
          manifest: result.status === 'ready' ? result.manifest : undefined,
        }),
        'legacy',
      )
    })
  })

  test('returns unresolved for a missing label without a legacy handle', () => {
    expectUnresolvedReason(
      resolveCustodyHandle({ account: account(), manifest: manifest() }),
      'missing-label',
    )
  })

  test('falls back to legacy for a missing label', () => {
    expectResolvedSource(
      resolveCustodyHandle({
        account: account({ claustrumHandle: legacyHandle }),
        manifest: manifest(),
      }),
      'legacy',
    )
  })

  test('returns unresolved for an invalid label without a legacy handle', () => {
    expectUnresolvedReason(
      resolveCustodyHandle({
        account: account({ label: 'Alice' }),
        manifest: manifest(),
      }),
      'invalid-label',
    )
  })

  test('falls back to legacy for an invalid label', () => {
    expectResolvedSource(
      resolveCustodyHandle({
        account: account({ label: 'Alice', claustrumHandle: legacyHandle }),
        manifest: manifest(),
      }),
      'legacy',
    )
  })

  test('returns unresolved for a duplicate OAuth label without a legacy handle', () => {
    expectUnresolvedReason(
      resolveCustodyHandle({
        account: account({ label: 'alice' }),
        manifest: manifest(),
        duplicateOAuthLabels: new Set(['alice']),
      }),
      'duplicate-label',
    )
  })

  test('falls back to legacy for a duplicate OAuth label', () => {
    expectResolvedSource(
      resolveCustodyHandle({
        account: account({ label: 'alice', claustrumHandle: legacyHandle }),
        manifest: manifest(),
        duplicateOAuthLabels: new Set(['alice']),
      }),
      'legacy',
    )
  })

  test('requires the canonical OAuth credential ID rather than the UUID', () => {
    const result = resolveCustodyHandle({
      account: account({ id: 'uuid-not-a-label', label: 'alice' }),
      manifest: manifest({
        accounts: [
          {
            label: 'alice',
            handle: activeHandle,
            credential_id: 'uuid-not-a-label',
          },
        ],
      }),
    })

    expectUnresolvedReason(result, 'missing-entry')
  })

  test('never falls back to legacy for a foreign serve', () => {
    const foreign = Object.assign(manifest(), {
      serve: 'foreign-serve',
    })

    expectUnresolvedReason(
      resolveCustodyHandle({
        account: account({ label: 'alice', claustrumHandle: legacyHandle }),
        manifest: foreign as never,
      }),
      'foreign-serve',
    )
  })

  test('rejects a matching active handle recorded as superseded', () => {
    expectUnresolvedReason(
      resolveCustodyHandle({
        account: account({ label: 'alice', claustrumHandle: legacyHandle }),
        manifest: manifest({
          accounts: [
            {
              label: 'alice',
              handle: activeHandle,
              credential_id: 'oauth:anthropic:alice',
              superseded: [activeHandle],
            },
          ],
        }),
      }),
      'superseded',
    )
  })

  test('rejects an active handle superseded by another manifest entry', () => {
    expectUnresolvedReason(
      resolveCustodyHandle({
        account: account({ label: 'alice' }),
        manifest: manifest({
          accounts: [
            {
              label: 'alice',
              handle: activeHandle,
              credential_id: 'oauth:anthropic:alice',
            },
            {
              label: 'bob',
              handle: otherHandle,
              credential_id: 'oauth:anthropic:bob',
              superseded: [activeHandle],
            },
          ],
        }),
      }),
      'superseded',
    )
  })
})
