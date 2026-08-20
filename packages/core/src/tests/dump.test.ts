import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dumpDirectRequest,
  dumpRelayRequest,
  dumpResponseArtifact,
  resetDumpState,
  setDumpEnabled,
  sweepDumpDirectory,
  writeDumpFile,
} from '../dump'

const dumpDirs: string[] = []
const dumpLinks: string[] = []
const originalDumpMaxBytes = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES
const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR

function dumpArtifactName(
  id: number,
  kind: 'body' | 'meta' | 'relay' | 'request' | 'response' = 'body',
) {
  return `2026-07-17T12-00-00-000Z-${String(id).padStart(6, '0')}-session-direct.${kind}.json`
}

afterEach(async () => {
  resetDumpState()
  if (originalDumpMaxBytes === undefined) {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES
  } else {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES = originalDumpMaxBytes
  }
  if (originalDumpDir === undefined) {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  } else {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
  }
  await Promise.all(
    dumpLinks.splice(0).map((path) => unlink(path).catch(() => {})),
  )
  await Promise.all(
    dumpDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

test('request dumps return response handles only when enabled', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

  expect(
    await dumpDirectRequest({
      affinity: 'ses-a',
      bodyText: '{}',
      route: 'oauth',
    }),
  ).toBeNull()
  setDumpEnabled(true)
  const direct = await dumpDirectRequest({
    affinity: 'ses-a',
    bodyText: '{}',
    route: 'oauth',
  })
  const relay = await dumpRelayRequest({
    affinity: 'ses-b',
    transport: 'http',
    protocol: 1,
    mode: 'full_sync',
    bodyText: '{}',
    payload: {},
    relayBytes: 2,
  })
  expect(direct?.responsePath).toMatch(/\.response\.json$/)
  expect(relay?.responsePath).toMatch(/\.response\.json$/)
  expect(await lstat(direct!.responsePath).catch(() => null)).toBeNull()
})

test('sweeps tagged dumps with a maximum-length affinity segment', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  setDumpEnabled(true)

  await dumpDirectRequest({
    affinity: 'a'.repeat(80),
    bodyText: '{"messages":[]}',
    tag: 'cachekeep',
  })

  expect(await readdir(dumpDir)).not.toEqual([])
  const result = await sweepDumpDirectory({
    dumpDir,
    maxBytes: 1,
    minAgeMs: 0,
    now: Date.now() + 1,
  })

  expect(result.removed).toBeGreaterThan(0)
  expect(await readdir(dumpDir)).toEqual([])
})

test('failed request dumps return no handle or orphan response artifact', async () => {
  if (process.getuid?.() === 0) return
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  await chmod(dumpDir, 0o500)
  try {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    setDumpEnabled(true)
    const handle = await dumpDirectRequest({
      affinity: 'ses-failure',
      bodyText: '{}',
    })
    expect(handle).toBeNull()
    expect(
      (await readdir(dumpDir)).some((name) => name.endsWith('.response.json')),
    ).toBe(false)
  } finally {
    await chmod(dumpDir, 0o700)
  }
})

test('response artifacts sanitize message fields and preserve diagnostics presence', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  setDumpEnabled(true)
  const handle = await dumpDirectRequest({ affinity: 'ses-a', bodyText: '{}' })
  expect(handle).not.toBeNull()
  await dumpResponseArtifact(handle, {
    status: 200,
    message: {
      id: 'msg_provider',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1 },
      diagnostics: null,
      content: [{ text: 'secret' }],
    },
  })
  const artifact = JSON.parse(await readFile(handle!.responsePath, 'utf8'))
  expect(artifact).toEqual({
    status: 200,
    message_id: 'msg_provider',
    model: 'claude-opus-4-7',
    usage: { input_tokens: 1 },
    diagnostics: null,
  })
  expect(JSON.stringify(artifact)).not.toContain('secret')
})

test('tagged prewarm dumps include the tag in filenames and metadata', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  setDumpEnabled(true)
  const handle = await dumpDirectRequest({
    affinity: 'ses-a',
    bodyText: '{}',
    tag: 'cachekeep',
  })
  expect(handle?.tag).toBe('cachekeep')
  expect(handle?.responsePath).toContain('-prewarm-cachekeep-')
  const files = await readdir(dumpDir)
  const metadata = JSON.parse(
    await readFile(
      join(dumpDir, files.find((name) => name.endsWith('.meta.json'))!),
      'utf8',
    ),
  )
  expect(metadata.tag).toBe('cachekeep')
})

test('dump sweep recognizes response artifacts', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const response = join(dumpDir, dumpArtifactName(1, 'response'))
  await writeFile(response, '12345678')
  await utimes(response, new Date(1_000), new Date(1_000))
  expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
})

test('dump sweep deletes oldest files until the directory is under its cap', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldFile = join(dumpDir, dumpArtifactName(1))
  const middleFile = join(dumpDir, dumpArtifactName(2, 'meta'))
  const newestFile = join(dumpDir, dumpArtifactName(3, 'request'))
  await mkdir(dumpDir, { recursive: true })
  await Promise.all([
    writeFile(oldFile, '12345678'),
    writeFile(middleFile, '12345678'),
    writeFile(newestFile, '12345678'),
  ])
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  await utimes(middleFile, new Date(2_000), new Date(2_000))
  await utimes(newestFile, new Date(3_000), new Date(3_000))

  const result = await sweepDumpDirectory({
    dumpDir,
    maxBytes: 12,
    protectedPaths: [newestFile],
  })

  expect(result).toEqual({ removed: 2, freedBytes: 16 })
  expect(await readdir(dumpDir)).toEqual([dumpArtifactName(3, 'request')])
})

test('evicts complete dump artifact groups instead of orphaning request pairs', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldBody = join(dumpDir, dumpArtifactName(1, 'body'))
  const oldMeta = join(dumpDir, dumpArtifactName(1, 'meta'))
  const newBody = join(dumpDir, dumpArtifactName(2, 'body'))
  const newMeta = join(dumpDir, dumpArtifactName(2, 'meta'))
  await Promise.all(
    [oldBody, oldMeta, newBody, newMeta].map((path) =>
      writeFile(path, '12345678'),
    ),
  )
  await Promise.all([
    utimes(oldBody, new Date(1_000), new Date(1_000)),
    utimes(oldMeta, new Date(2_000), new Date(2_000)),
    utimes(newBody, new Date(3_000), new Date(3_000)),
    utimes(newMeta, new Date(4_000), new Date(4_000)),
  ])

  // Removing one file would satisfy this cap but leave an unusable orphan. The
  // sweep must evict both artifacts belonging to the oldest request instead.
  expect(await sweepDumpDirectory({ dumpDir, maxBytes: 24 })).toEqual({
    removed: 2,
    freedBytes: 16,
  })
  expect((await readdir(dumpDir)).sort()).toEqual(
    [dumpArtifactName(2, 'body'), dumpArtifactName(2, 'meta')].sort(),
  )
})

test('sweeps artifacts whose request counter has grown to seven digits', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const artifact = join(
    dumpDir,
    '2026-07-17T12-00-00-000Z-1000000-session-direct.body.json',
  )
  await writeFile(artifact, '12345678')
  await utimes(artifact, new Date(1_000), new Date(1_000))

  expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect(await readdir(dumpDir)).toEqual([])
})

describe('dump sweep safety guard', () => {
  test('refuses a configured symlinked dump directory without deleting target files', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'target-dir-secret-'))
    dumpDirs.push(targetDir)
    const secretFile = join(targetDir, 'secret.txt')
    await writeFile(secretFile, 'do not delete me')
    const dumpDir = join(
      tmpdir(),
      `opencode-anthropic-auth-dumps-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    dumpLinks.push(dumpDir)
    await symlink(targetDir, dumpDir)
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    expect(await sweepDumpDirectory({ maxBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(targetDir)).toEqual(['secret.txt'])
  })

  test('refuses a directory that is not configured for dumps', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'unrelated-dumps-test-'))
    dumpDirs.push(dumpDir)
    await writeFile(join(dumpDir, 'old.json'), '12345678')
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR

    expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(dumpDir)).toEqual(['old.json'])
  })
})

test('enforces the cap in a configured custom dump directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'custom-dump-root-'))
  dumpDirs.push(root)
  const dumpDir = join(root, 'dumps')
  await mkdir(dumpDir)
  const oldDump = join(dumpDir, dumpArtifactName(1))
  const newDump = join(dumpDir, dumpArtifactName(2, 'meta'))
  const unrelatedFile = join(dumpDir, 'system.log')
  await Promise.all([
    writeFile(oldDump, '12345678'),
    writeFile(newDump, '12345678'),
    writeFile(unrelatedFile, 'unrelated file must survive'),
  ])
  await utimes(oldDump, new Date(1_000), new Date(1_000))
  await utimes(newDump, new Date(2_000), new Date(2_000))
  await utimes(unrelatedFile, new Date(500), new Date(500))
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

  expect(await sweepDumpDirectory({ maxBytes: 8 })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect((await readdir(dumpDir)).sort()).toEqual(
    [dumpArtifactName(2, 'meta'), 'system.log'].sort(),
  )
})

test('disables dump sweeping when the configured cap is zero', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldFile = join(dumpDir, dumpArtifactName(1))
  await writeFile(oldFile, '12345678')
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES = '0'

  expect(await sweepDumpDirectory({ dumpDir })).toEqual({
    removed: 0,
    freedBytes: 0,
  })
  expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
})

test('preserves files younger than the sweep newness floor', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const recentFile = join(dumpDir, dumpArtifactName(1))
  const now = new Date('2026-07-17T12:00:00.000Z')
  await writeFile(recentFile, '12345678')
  await utimes(recentFile, now, now)

  expect(
    await sweepDumpDirectory({
      dumpDir,
      maxBytes: 1,
      now: now.getTime(),
    }),
  ).toEqual({ removed: 0, freedBytes: 0 })
  expect(await readdir(dumpDir)).toEqual([dumpArtifactName(1)])
})

test('preserves fresh partials and reclaims stale partials even under the cap', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const now = new Date('2026-07-17T12:00:00.000Z')
  const freshPartial = join(dumpDir, `${dumpArtifactName(1)}.partial`)
  const stalePartial = join(
    dumpDir,
    `${dumpArtifactName(2)}.0123456789abcdef01234567.partial`,
  )
  await Promise.all([
    writeFile(freshPartial, '12345678'),
    writeFile(stalePartial, '12345678'),
  ])
  await utimes(freshPartial, now, now)
  await utimes(
    stalePartial,
    new Date(now.getTime() - 11 * 60 * 1000),
    new Date(now.getTime() - 11 * 60 * 1000),
  )

  expect(
    await sweepDumpDirectory({
      dumpDir,
      maxBytes: 100,
      now: now.getTime(),
    }),
  ).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect(await readdir(dumpDir)).toEqual([`${dumpArtifactName(1)}.partial`])
})

test('does not follow a pre-planted predictable partial symlink', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  const targetDir = await mkdtemp(join(tmpdir(), 'dump-partial-target-'))
  dumpDirs.push(dumpDir, targetDir)
  const targetFile = join(targetDir, 'target.txt')
  const finalFile = join(dumpDir, dumpArtifactName(1))
  await writeFile(targetFile, 'do not overwrite')
  await symlink(targetFile, `${finalFile}.partial`)

  await writeDumpFile(finalFile, 'safe dump content')

  expect(await readFile(targetFile, 'utf8')).toBe('do not overwrite')
  expect(await readFile(finalFile, 'utf8')).toBe('safe dump content')
  expect((await lstat(finalFile)).isSymbolicLink()).toBe(false)
})
