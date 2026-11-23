import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheKeepClaim } from '../cachekeep-store.ts'

test('a forward wall-clock step during publication does not prevent claiming a live session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const realNow = Date.now
  let offset = 0
  const claim = new CacheKeepClaim(root, 'session', {
    liveness: {
      pidAlive: (pid) => pid === process.pid,
      incarnation: async () => {
        // Step the wall clock while the process is reading its own identity.
        offset = 30_000
        return 'live-process'
      },
    },
  })
  try {
    Date.now = () => realNow() + offset
    expect(await claim.acquire()).toBe(true)
    expect(await claim.isCurrent()).toBe(true)
  } finally {
    Date.now = realNow
    try {
      await claim.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('a forward wall-clock step cannot displace a live claim without an incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const realNow = Date.now
  const liveness = {
    pidAlive: (pid: number) => pid === process.pid,
    incarnation: async () => null,
    uptime: () => 60,
  }
  const holder = new CacheKeepClaim(root, 'session', { liveness })
  const contender = new CacheKeepClaim(root, 'session', { liveness })
  try {
    expect(await holder.acquire()).toBe(true)
    expect(await contender.acquire()).toBe(false)
    // Correct a wall clock that was ten minutes slow shortly after boot.
    Date.now = () => realNow() + 10 * 60_000
    expect(await holder.isCurrent()).toBe(true)
    expect(await contender.acquire()).toBe(false)
    expect(await holder.isCurrent()).toBe(true)
  } finally {
    Date.now = realNow
    try {
      await contender.release()
      await holder.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
