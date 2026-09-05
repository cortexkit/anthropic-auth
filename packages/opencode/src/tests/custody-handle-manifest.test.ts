import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CustodyHandleManifestReader,
  readCustodyHandles,
  resolveCustodyHandle,
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

  test('rejects invalid handles with a fixed reason', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], handle: 'invalid' },
        ]
      }),
      async (path) => {
        await expect(reader(path).read()).resolves.toEqual({
          status: 'invalid',
          reason: 'invalid account handle',
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
          credential_id: 'oauth:anthropic:writer',
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
