import { expect, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockPathFor } from '@cortexkit/common-auth/fs'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { CensusLockDiagnostics } from './fallback-census-lock-diagnostics'

const lifetime = createTestLifetimeSuite()

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), 'fallback-census-lock-diagnostics-'),
  )
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'vault-runtime.json')
  const name = 'native-runtime'
  return { root, path, name, lease: lockPathFor(path, name) }
}

lifetime.test(
  'lock observations stay silent and failure snapshots read the current lease',
  async () => {
    const f = await fixture()
    const diagnostics = new CensusLockDiagnostics('pending lastUsed fixture')
    const output = spyOn(console, 'error').mockImplementation(() => {})
    try {
      diagnostics.observe({ type: 'acquiring', path: f.path, name: f.name })
      const content = JSON.stringify({
        ownerId: 'lease-owner-uuid',
        expiresAt: 123,
      })
      await writeFile(f.lease, content)
      const mtime = (await stat(f.lease)).mtimeMs
      const snapshot = diagnostics.snapshot()
      expect(output).not.toHaveBeenCalled()
      expect(snapshot.fixture).toBe('pending lastUsed fixture')
      expect(snapshot.locks).toHaveLength(1)
      expect(snapshot.locks[0]).toMatchObject({
        path: f.path,
        name: 'native-runtime',
        attempts: 1,
        acquired: 0,
        released: 0,
        lastEvent: 'acquiring',
        lease: {
          path: f.lease,
          kind: 'file',
          mtimeMs: mtime,
          content,
          ownerPid: null,
          ownerAlive: 'unknown: lease has no valid PID',
        },
        observedAcquisitions: [],
      })
    } finally {
      output.mockRestore()
    }
  },
)

lifetime.test(
  'legacy PID owners are probed without treating a UUID as a PID',
  async () => {
    const f = await fixture()
    const diagnostics = new CensusLockDiagnostics('legacy owner fixture')
    await writeFile(
      f.lease,
      JSON.stringify({ pid: process.pid, expiresAt: 123 }),
    )
    diagnostics.observe({ type: 'acquiring', path: f.path, name: f.name })
    expect(diagnostics.snapshot().locks[0]?.lease).toMatchObject({
      ownerPid: process.pid,
      ownerAlive: 'yes',
    })
  },
)

lifetime.test(
  'ownerless directory leases and eviction markers retain their mtime evidence',
  async () => {
    const f = await fixture()
    const diagnostics = new CensusLockDiagnostics('ownerless fixture')
    await mkdir(f.lease)
    await mkdir(`${f.lease}.evicting`)
    const marker = JSON.stringify({ ownerId: 'marker-owner', createdAt: 456 })
    await writeFile(join(`${f.lease}.evicting`, 'owner.json'), marker)
    diagnostics.observe({ type: 'acquiring', path: f.path, name: f.name })
    const snapshot = diagnostics.snapshot().locks[0]
    expect(snapshot?.lease).toMatchObject({
      kind: 'directory',
      readError: 'ENOENT',
      mtimeMs: (await stat(f.lease)).mtimeMs,
    })
    expect(snapshot?.evictionMarker).toMatchObject({
      kind: 'directory',
      content: marker,
    })
  },
)

lifetime.test(
  'an earlier fixture acquisition is labeled separately from the actual owner',
  async () => {
    const f = await fixture()
    const earlier = new CensusLockDiagnostics('earlier fixture')
    earlier.observe({ type: 'acquiring', path: f.path, name: f.name })
    earlier.observe({ type: 'acquired', path: f.path, name: f.name })
    earlier.observe({ type: 'released', path: f.path, name: f.name })
    const current = new CensusLockDiagnostics('current fixture')
    await writeFile(f.lease, JSON.stringify({ ownerId: 'unobserved-owner' }))
    current.observe({
      type: 'acquiring',
      path: f.path,
      name: f.name,
      detached: true,
    })
    const snapshot = current.snapshot().locks[0]
    expect(snapshot?.observedAcquisitions).toEqual([
      expect.objectContaining({ fixture: 'earlier fixture', pid: process.pid }),
    ])
    expect(snapshot?.lease).toMatchObject({ ownerPid: null })
    expect(snapshot?.events).toEqual([
      expect.objectContaining({ type: 'acquiring', detached: true }),
    ])
    expect(earlier.snapshot().locks[0]).toMatchObject({
      attempts: 1,
      acquired: 1,
      released: 1,
      lastEvent: 'released',
    })
  },
)

lifetime.test(
  'failure snapshots tolerate missing leases and do not follow symlinks',
  async () => {
    const f = await fixture()
    const diagnostics = new CensusLockDiagnostics('unexpected lease fixture')
    diagnostics.observe({ type: 'acquiring', path: f.path, name: f.name })
    expect(diagnostics.snapshot().locks[0]?.lease).toMatchObject({
      readError: 'ENOENT',
    })
    const unexpected = join(f.root, 'not-a-lease')
    await writeFile(unexpected, 'must not be read')
    await symlink(unexpected, f.lease)
    const snapshot = diagnostics.snapshot().locks[0]?.lease
    expect(snapshot).toMatchObject({ kind: 'symlink' })
    expect(snapshot).not.toHaveProperty('content', 'must not be read')
  },
)
