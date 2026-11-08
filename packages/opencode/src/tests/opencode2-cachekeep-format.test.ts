import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CacheKeepTarget,
  CacheKeepStore as CoreStore,
} from '@cortexkit/anthropic-auth-core'
import { CacheKeepStore } from '../v2/cachekeep-store.ts'
import { CacheKeepStore as ReleasedStore } from './fixtures/cachekeep-store-2.5.5.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'cachekeep-format-'))
  roots.push(path)
  return path
}

const now = 1_800_000_000_000
const target: CacheKeepTarget = {
  id: 'session-release-compatibility',
  url: 'https://api.anthropic.com/v1/messages',
  headers: { authorization: 'never-persist-this' },
  bodyText: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
  bodyBytes: 0,
  cacheExpiresAt: now + 3_600_000,
  nextPrewarmAt: now + 3_300_000,
  consecutiveFailures: 0,
  dayKey: '2027-01-15',
  oauthAccountIdentity: 'account@example.com',
  isSubagent: false,
  ttlMs: 3_600_000,
  lastTouchAt: now,
  lastTouchKind: 'response',
}

test('OC2 v2.5.5 reads current records and the current reader reads v2.5.5 records', async () => {
  const options = { storageId: 'same-oc2-storage', root: await root() }
  const current = new CacheKeepStore(options)
  const released = new ReleasedStore(options)
  expect(current.directory).toBe(released.directory)
  current.changed({
    ...target,
    policyState: {
      ownerSessionId: target.id,
      planned: true,
      lastRealRequestAt: now,
      warmsSinceLastRealRequest: 23,
      warmCostSoFar: 100,
      prefixTokens: 1000,
      inputTokens: 1100,
      hasWarmed: true,
    },
  })
  await current.drain()
  const oldRead: string[] = []
  await released.load(now, (entry) => {
    oldRead.push(entry.bodyText)
    return true
  })
  expect(oldRead).toEqual([target.bodyText])

  const updated = {
    ...target,
    bodyText:
      '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"latest"}]}',
  }
  released.changed(updated)
  await released.drain()
  const newRead: string[] = []
  await current.load(now, (entry) => {
    newRead.push(entry.bodyText)
    return true
  })
  expect(newRead).toEqual([updated.bodyText])
})

test('the shared writer produces byte-identical v2.5.5 gzip records', async () => {
  const shared = new CoreStore({
    storageId: 'oc2',
    root: await root(),
    pluginVersion: '2.5.5',
  })
  const released = new ReleasedStore({ storageId: 'oc2', root: await root() })
  shared.changed(target)
  released.changed(target)
  await Promise.all([shared.drain(), released.drain()])
  const [name] = await readdir(shared.directory)
  expect(name).toBeDefined()
  expect(await readFile(join(shared.directory, name!))).toEqual(
    await readFile(join(released.directory, name!)),
  )
})
