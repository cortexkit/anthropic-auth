import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  type CacheKeepTarget,
  CacheKeepStore as CoreStore,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { CacheKeepStore } from '../v2/cachekeep-store.ts'
import { CacheKeepStore as ReleasedStore } from './fixtures/cachekeep-store-2.5.5.ts'
import { CacheKeepStore as Published260Store } from './fixtures/cachekeep-store-2.6.0.ts'
import { invalidReason as published2131InvalidReason } from './fixtures/cachekeep-validator-2.13.1.ts'

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

test('Core 2.13.1 validator accepts new saved policy snapshots on rollback', async () => {
  const current = new CacheKeepStore({
    storageId: 'rollback-2131',
    root: await root(),
  })
  const policy = {
    ttl: 'long',
    keep_warm: 'hours',
    hours: { from: '09:00', to: '18:00', tz: 'UTC' },
  } as const
  current.changed({
    ...target,
    policyState: {
      ownerSessionId: target.id,
      planned: true,
      policy,
      lastRealRequestAt: now,
      warmsSinceLastRealRequest: 7,
      warmCostSoFar: 123,
      pendingWarmCost: 5,
      stopReported: true,
      hasWarmed: true,
    },
  })
  await current.drain()
  const [name] = await readdir(current.directory)
  const entry = JSON.parse(
    gunzipSync(await readFile(join(current.directory, name!))).toString(),
  )
  expect(entry.policyState.policy).toEqual(policy)
  expect(entry.policyState.stopReported).toBe(true)
  expect(published2131InvalidReason(entry, name!, now)).toBeUndefined()
  expect(published2131InvalidReason({ ...entry, v: 2 }, name!, now)).toBe(
    'format',
  )
})

test('expired planned restart records report a contracted stop before deletion', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  const reports: unknown[] = []
  globals[key] = () => ({ report: (payload: unknown) => reports.push(payload) })
  try {
    const current = new CacheKeepStore({
      storageId: 'expired-plan',
      root: await root(),
    })
    current.changed({
      ...target,
      policyState: {
        ownerSessionId: target.id,
        planned: true,
        policy: { keep_warm: 'auto' },
        lastRealRequestAt: now,
        warmsSinceLastRealRequest: 0,
        warmCostSoFar: 0,
        hasWarmed: false,
      },
    })
    await current.drain()
    const expiredAt = target.cacheExpiresAt + 1
    let accepted = false
    await current.load(expiredAt, () => {
      accepted = true
      return true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(accepted).toBe(true)
    expect(await readdir(current.directory)).toEqual([])
    expect(reports).toEqual([
      { kind: 'cache_warm_stopped', at: expiredAt, reason: 'deadline-missed' },
    ])
  } finally {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  }
})

test.each(['account-gone', 'foreign-identity'] as const)(
  'planned %s restore drops report only validated record owners',
  async (reason) => {
    const key = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[key]
    const level = getLogLevel()
    const logs: LogTestRecord[] = []
    const reports: unknown[] = []
    globals[key] = () => ({
      report: (payload: unknown) => reports.push(payload),
    })
    setLogLevel('info')
    __setLogTestSink((record) => logs.push(record))
    try {
      for (const valid of [false, true]) {
        reports.length = 0
        logs.length = 0
        const current = new CacheKeepStore({
          storageId: 'account-drop',
          root: await root(),
        })
        current.changed({
          ...target,
          policyState: {
            ownerSessionId: target.id,
            planned: true,
            policy: { keep_warm: 'auto' },
            lastRealRequestAt: now,
            warmsSinceLastRealRequest: 0,
            warmCostSoFar: valid ? 0 : -1,
            hasWarmed: false,
          },
        })
        await current.drain()
        let accepted = false
        await current.load(now, () => {
          accepted = true
          return reason
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(accepted).toBe(valid)
        expect(await readdir(current.directory)).toEqual([])
        expect(reports).toEqual(
          valid
            ? [{ kind: 'cache_warm_stopped', at: now, reason: 'unsupported' }]
            : [],
        )
        expect(
          logs.filter((record) => record.message === 'stopped warming session'),
        ).toEqual(
          valid
            ? [
                expect.objectContaining({
                  level: 'info',
                  payload: {
                    session: target.id,
                    reason,
                    stage: 'restore-account',
                  },
                }),
              ]
            : [],
        )
      }
    } finally {
      if (original === undefined) delete globals[key]
      else globals[key] = original
      __setLogTestSink(null)
      setLogLevel(level)
    }
  },
)

test.each(['live-target', 'no-lease'] as const)(
  'expired restore respects %s guard without stopping or deleting its record',
  async () => {
    const key = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[key]
    const reports: unknown[] = []
    globals[key] = () => ({
      report: (payload: unknown) => reports.push(payload),
    })
    try {
      const current = new CacheKeepStore({
        storageId: 'guarded-expired',
        root: await root(),
      })
      const expired = {
        ...target,
        policyState: {
          ownerSessionId: target.id,
          planned: true,
          lastRealRequestAt: now,
          warmsSinceLastRealRequest: 0,
          warmCostSoFar: 0,
          hasWarmed: false,
        },
      }
      current.changed(expired)
      await current.drain()
      let guarded = false
      const liveBody =
        '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"new real turn"}]}'
      await current.load(target.cacheExpiresAt + 1, () => {
        guarded = true
        current.changed({
          ...expired,
          bodyText: liveBody,
          cacheExpiresAt: target.cacheExpiresAt + 3_600_000,
        })
        return undefined
      })
      await current.drain()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(guarded).toBe(true)
      const [name] = await readdir(current.directory)
      expect(name).toBeDefined()
      expect(
        JSON.parse(
          gunzipSync(await readFile(join(current.directory, name!))).toString(),
        ).bodyText,
      ).toBe(liveBody)
      expect(reports).toEqual([])
    } finally {
      if (original === undefined) delete globals[key]
      else globals[key] = original
    }
  },
)

test('persisted stop marker prevents a second report after a crash before unlink', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  const reports: unknown[] = []
  globals[key] = () => ({ report: (payload: unknown) => reports.push(payload) })
  try {
    const options = { storageId: 'reported-stop', root: await root() }
    const current = new CacheKeepStore(options)
    expect(
      await current.reserveWarm({
        ...target,
        policyState: {
          ownerSessionId: target.id,
          planned: true,
          lastRealRequestAt: now,
          warmsSinceLastRealRequest: 1,
          warmCostSoFar: 200,
          hasWarmed: true,
          stopReported: true,
        },
      }),
    ).toBe(true)
    const restarted = new CacheKeepStore(options)
    await restarted.load(target.cacheExpiresAt + 1, () => 'expired')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([])
    expect(await readdir(current.directory)).toEqual([])
  } finally {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  }
})

test.each(['expired', 'account-gone'] as const)(
  'a live record arriving during %s marker persistence is neither reported nor unlinked',
  async (disposition) => {
    const key = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[key]
    const reports: unknown[] = []
    globals[key] = () => ({
      report: (payload: unknown) => reports.push(payload),
    })
    try {
      const current = new CacheKeepStore({
        storageId: 'load-race',
        root: await root(),
      })
      const saved = {
        ...target,
        policyState: {
          ownerSessionId: target.id,
          planned: true,
          lastRealRequestAt: now,
          warmsSinceLastRealRequest: 0,
          warmCostSoFar: 0,
          hasWarmed: false,
        },
      }
      await current.reserveWarm(saved)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const write = Reflect.get(current, 'writeEntry').bind(current)
      const marker = spyOn(current as any, 'writeEntry').mockImplementation(
        async (entry: any, directory: string) => {
          if (entry.policyState?.stopReported) {
            entered.resolve()
            await release.promise
          }
          return write(entry, directory)
        },
      )
      let live = false
      const loading = current.load(
        disposition === 'expired' ? target.cacheExpiresAt + 1 : now,
        () => disposition,
        undefined,
        () => !live,
      )
      await entered.promise
      live = true
      let written = false
      const bodyText =
        '{"model":"claude-opus-4-6","system":"new accepted prefix"}'
      const fresh = current
        .reserveWarm({
          ...saved,
          bodyText,
          cacheExpiresAt: target.cacheExpiresAt + 3_600_000,
        })
        .then(() => {
          written = true
        })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const overtookMarker = written
      release.resolve()
      await Promise.all([loading, fresh])
      marker.mockRestore()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(overtookMarker).toBe(false)
      expect(reports).toEqual([])
      const [name] = await readdir(current.directory)
      expect(name).toBeDefined()
      expect(
        JSON.parse(
          gunzipSync(await readFile(join(current.directory, name!))).toString(),
        ).bodyText,
      ).toBe(bodyText)
    } finally {
      if (original === undefined) delete globals[key]
      else globals[key] = original
    }
  },
)

test.each(['format', 'unreadable'] as const)(
  'a live per-file guard protects a %s restart file',
  async (invalid) => {
    const current = new CacheKeepStore({
      storageId: 'invalid-live',
      root: await root(),
    })
    await current.reserveWarm(target)
    const [name] = await readdir(current.directory)
    const path = join(current.directory, name!)
    await writeFile(
      path,
      invalid === 'format'
        ? gzipSync(JSON.stringify({ ...target, v: 999 }))
        : new Uint8Array([0, 1, 2]),
    )
    await current.load(
      now,
      () => undefined,
      undefined,
      () => false,
    )
    expect(await readdir(current.directory)).toEqual([name!])
  },
)

test('a failed restore marker write still reports the terminal stop', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  const reports: unknown[] = []
  globals[key] = () => ({ report: (payload: unknown) => reports.push(payload) })
  try {
    const current = new CacheKeepStore({
      storageId: 'failed-marker',
      root: await root(),
    })
    await current.reserveWarm({
      ...target,
      policyState: {
        ownerSessionId: target.id,
        planned: true,
        lastRealRequestAt: now,
        warmsSinceLastRealRequest: 0,
        warmCostSoFar: 0,
        hasWarmed: false,
      },
    })
    const marker = spyOn(current as any, 'writeEntry').mockRejectedValue(
      new Error('disk write failed'),
    )
    await current.load(target.cacheExpiresAt + 1, () => 'expired')
    marker.mockRestore()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toEqual([
      {
        kind: 'cache_warm_stopped',
        at: target.cacheExpiresAt + 1,
        reason: 'deadline-missed',
      },
    ])
    expect(await readdir(current.directory)).toEqual([])
  } finally {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  }
})

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

test('published Core 2.6.0 reader accepts format-one records with bounded policy and unresolved dispatch cost', async () => {
  const options = {
    storageId: 'published-260-compatibility',
    root: await root(),
    pluginVersion: '2.6.0',
  }
  const current = new CacheKeepStore(options)
  const released = new Published260Store(options, undefined)
  const policyState = {
    ownerSessionId: target.id,
    planned: true,
    lastRealRequestAt: now,
    warmsSinceLastRealRequest: 23,
    warmCostSoFar: 100,
    pendingWarmCost: 5,
    prefixTokens: 1_000,
    inputTokens: 1_100,
    hasWarmed: true,
  }
  current.changed({ ...target, policyState })
  await current.drain()
  const read: unknown[] = []
  await released.load(
    now,
    (entry: unknown) => {
      read.push(entry)
      return true
    },
    undefined,
  )
  expect(read).toEqual([
    expect.objectContaining({
      v: 1,
      id: target.id,
      bodyText: target.bodyText,
      policyState,
    }),
  ])
  expect(await readdir(current.directory)).toHaveLength(1)
})
