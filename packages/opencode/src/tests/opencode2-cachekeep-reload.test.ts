import { afterEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  CacheKeepManager,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  type NativeAccountRuntime,
} from '@cortexkit/anthropic-auth-core'
import { createNativeCacheKeep } from '../v2/cachekeep'
import { CacheKeepStore } from '../v2/cachekeep-store'
import type { NativeSource } from '../v2/source'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test.each([false, true])(
  'OpenCode 2 reload never accesses a 2.16.6 keeper in the old slot (retained: %s)',
  async (retained) => {
    const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-reload-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const storageId = randomUUID()
    const now = Date.now()
    const policy: Awaited<
      ReturnType<NativeAccountRuntime['read']>
    >['policyStorage'] = {
      version: 1,
      accounts: [],
      claudeCache: { enabled: true, mode: 'hybrid' },
      cacheKeep: { enabled: true, always: true },
    }
    const binding = { storageId, rowId: 'first', credentialEpoch: 0 }
    const accountIdentity = '11111111-2222-4333-8444-555555555555'
    const runtime = {
      read: async () => ({
        policyStorage: policy,
        accounts: [
          {
            id: 'first',
            type: 'oauth',
            source: 'local',
            accountIdentity,
            binding,
          },
        ],
      }),
    } as unknown as NativeAccountRuntime
    const disk = new CacheKeepSessionRegistry({
      directory: join(directory, 'registry'),
      now: () => now,
    })
    type LegacySession = {
      id: string
      cacheExpiresAt: number
      nextPrewarmAt: number
    }
    const registry = {
      publish: (sessions: readonly LegacySession[]) =>
        disk.publish(
          sessions.map(({ id, cacheExpiresAt, nextPrewarmAt }) => ({
            id,
            cacheExpiresAt,
            nextPrewarmAt,
          })),
        ),
      list: () => disk.list(),
      dispose: () => disk.dispose(),
    }
    const persistence = new CacheKeepStore({ storageId, root: directory })
    const timers = new Set<object>()
    const manager = new CacheKeepManager({
      now: () => now,
      loadStorage: async () => policy,
      setIntervalImpl: (() => {
        const timer = { unref() {} }
        timers.add(timer)
        return timer
      }) as unknown as typeof setInterval,
      clearIntervalImpl: ((timer: object) => {
        timers.delete(timer)
      }) as unknown as typeof clearInterval,
      onTargetChanged: (target) => owner.persistence.changed(target),
      onTargetRemoved: (_id, target) => owner.persistence.removed(target),
    })
    cleanups.push(() => manager.stop())
    const target = {
      sessionId: 'ses_before_reload',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText:
        '{"model":"claude-sonnet-4-6","system":[{"type":"text","text":"Keep this prefix","cache_control":{"type":"ephemeral","ttl":"1h"}}],"messages":[{"role":"user","content":"Hello"}]}',
      storage: policy,
      cacheMode: 'hybrid' as const,
      oauthAccountId: 'first',
      oauthAccountIdentity: JSON.stringify([
        'local',
        accountIdentity,
        null,
        storageId,
        'first',
        0,
      ]),
    }
    const lease = { stopped: false }
    const owner = {
      manager,
      registry,
      persistence,
      prepared: new Map(),
      leases: new Map(retained ? [] : [[0, lease]]),
      nextGeneration: 1,
      persistenceFollowsOwner: true,
      retain: () => manager.stop(),
      adopt: async () => {
        manager.start()
        await registry.publish(manager.trackedSessions())
      },
    }
    expect(manager.track(target).tracked).toBe(true)
    await persistence.drain()
    if (retained) manager.stop()
    if (!retained) manager.start()
    const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    const legacy = new Map([[storageId, owner]])
    const touches: string[] = []
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: () => {
        touches.push('read')
        return legacy
      },
      set: () => {
        touches.push('write')
      },
    })
    cleanups.push(() => {
      if (original) Object.defineProperty(globalThis, key, original)
      else Reflect.deleteProperty(globalThis, key)
    })
    const keep = createNativeCacheKeep({
      storageId,
      runtime,
      source: {} as NativeSource,
      persistence: { root: directory },
      registryDirectory: join(directory, 'registry'),
      now: () => now,
    })
    cleanups.push(() => keep.dispose())
    await keep.ready
    expect(touches).toEqual([])
    const current = [
      ...(globalThis as any)[
        Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v3')
      ]
        .get(storageId)
        .values(),
    ][0]
    expect(keep.registry).not.toBe(
      registry as unknown as CacheKeepSessionRegistry,
    )
    expect(legacy.get(storageId)).toBe(owner)
    expect(timers.size).toBe(retained ? 0 : 1)
    await keep.track({
      sessionID: 'ses_after_reload',
      attemptId: 'after-reload',
      route: 'oauth',
      agent: 'build',
      kind: 'primary',
      accountId: 'first',
      url: target.url,
      bodyText: target.bodyText,
      provenance: { kind: 'local', subject: { binding } },
    } as Parameters<typeof keep.track>[0])
    expect(
      keep.onResponseHeaders({ attemptId: 'after-reload', status: 200 })
        ?.tracked,
    ).toBe(true)
    expect(
      (await keep.registry.list()).map(
        ({ id, cacheExpiresAt, nextPrewarmAt }) => ({
          id,
          cacheExpiresAt,
          nextPrewarmAt,
        }),
      ),
    ).toEqual(
      ['ses_after_reload', 'ses_before_reload'].map((id) => ({
        id,
        cacheExpiresAt: now + 3_600_000,
        nextPrewarmAt: now + 3_300_000,
      })),
    )
    expect(timers.size).toBe(retained ? 0 : 1)
    expect(lease.stopped).toBe(false)
    expect(touches).toEqual([])
    keep.forgetSession('ses_before_reload')
    expect(
      current.manager.trackedSessions().map(({ id }: LegacySession) => id),
    ).toEqual(['ses_after_reload'])
    policy.cacheKeep = { enabled: false }
    await keep.track({
      sessionID: 'ses_disabled',
      attemptId: 'disabled',
      route: 'oauth',
      agent: 'build',
      kind: 'primary',
    } as Parameters<typeof keep.track>[0])
    expect(current.manager.trackedSessions()).toEqual([])
    await current.localCleanup
    await current.persistence.drain()
    expect(await readdir(current.persistence.directory)).toEqual([])
  },
)

test('OpenCode 2 hybrid disable preserves a planned record written while the sweep waits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-mixed-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const storageId = randomUUID()
  let now = Date.now()
  const policy: Awaited<
    ReturnType<NativeAccountRuntime['read']>
  >['policyStorage'] = {
    version: 1,
    accounts: [],
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }
  const binding = { storageId, rowId: 'first', credentialEpoch: 0 }
  const runtime = {
    read: async () => ({
      policyStorage: policy,
      accounts: [
        {
          id: 'first',
          accountIdentity: '11111111-2222-4333-8444-555555555555',
          binding,
        },
      ],
    }),
  } as unknown as NativeAccountRuntime
  const routingKey = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const originalRouting = globals[routingKey]
  globals[routingKey] = (sessionId: string) =>
    sessionId === 'ses_runner'
      ? { cache: () => ({ ttl: 'long', keep_warm: 'always' }) }
      : undefined
  cleanups.push(() => {
    if (originalRouting === undefined) delete globals[routingKey]
    else globals[routingKey] = originalRouting
  })
  const keep = createNativeCacheKeep({
    storageId,
    runtime,
    source: {} as NativeSource,
    persistence: { root: directory },
    now: () => now,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
    setTimeoutImpl: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => {}) as typeof clearTimeout,
  })
  cleanups.push(() => keep.dispose())
  await keep.ready
  const shared = [
    ...(globalThis as any)[
      Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v3')
    ]
      .get(storageId)
      .values(),
  ][0]
  const persistence: CacheKeepStore = shared.persistence
  const input = {
    attemptId: 'local',
    sessionID: 'ses_local',
    route: 'oauth',
    agent: 'build',
    kind: 'primary',
    accountId: 'first',
    url: 'https://api.anthropic.com/v1/messages',
    bodyText:
      '{"model":"claude-sonnet-4-6","system":[{"type":"text","text":"Kept prefix","cache_control":{"type":"ephemeral","ttl":"1h"}}],"messages":[{"role":"user","content":"Hello"}]}',
    provenance: { kind: 'local', subject: { binding } },
  } as Parameters<typeof keep.track>[0]
  for (const id of ['local', 'runner']) {
    await keep.track({ ...input, attemptId: id, sessionID: `ses_${id}` })
    expect(
      keep.onResponseHeaders({ attemptId: id, status: 200 })?.tracked,
    ).toBe(true)
  }
  await shared.persistence.drain()
  expect(
    (await readdir(shared.persistence.directory)).filter((name) =>
      name.endsWith('.json.gz'),
    ),
  ).toHaveLength(2)
  const runner = (
    Reflect.get(shared.manager, 'targets') as Map<string, CacheKeepTarget>
  ).get('ses_runner')!
  const peer = new CacheKeepStore({
    storageId,
    root: directory,
    sessionClaims: true,
  })
  await persistence.releaseClaims(() => true)
  cleanups.push(() => peer.releaseClaims(() => true))
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const drain = persistence.drain.bind(persistence)
  const draining = spyOn(persistence, 'drain').mockImplementationOnce(
    async () => {
      entered.resolve()
      await resume.promise
      await drain()
    },
  )
  const peerCommit = now + 10_000
  try {
    policy.cacheKeep = { enabled: false }
    await keep.track({ ...input, attemptId: 'disabled' })
    await entered.promise
    now = peerCommit
    peer.changed({
      ...runner,
      policyState: { ...runner.policyState!, lastRealRequestAt: peerCommit },
    })
    await peer.drain()
    expect(peer.isCommitted(runner.id)).toBe(true)
    await peer.releaseClaims(() => true)
  } finally {
    resume.resolve()
    await shared.localCleanup
    draining.mockRestore()
  }
  await persistence.drain()
  expect(
    shared.manager.trackedSessions().map(({ id }: { id: string }) => id),
  ).toEqual(['ses_runner'])
  const files = (await readdir(shared.persistence.directory)).filter((name) =>
    name.endsWith('.json.gz'),
  )
  expect(files).toHaveLength(1)
  const saved = JSON.parse(
    gunzipSync(
      await readFile(join(shared.persistence.directory, files[0]!)),
    ).toString(),
  )
  expect(saved.id).toBe('ses_runner')
  expect(saved.policyState.lastRealRequestAt).toBe(peerCommit)
  const reports: unknown[] = []
  shared.manager.track({
    sessionId: 'ses_runner',
    url: input.url,
    bodyText: input.bodyText,
    headers: new Headers(),
    storage: policy,
    cacheMode: 'hybrid',
    oauthAccountId: 'first',
    oauthAccountIdentity: '11111111-2222-4333-8444-555555555555',
    retained: {
      ...saved,
      policyState: { ...saved.policyState, hasWarmed: true },
    },
  })
  globals[routingKey] = () => ({
    cache: () => null,
    report: (payload: unknown) => reports.push(payload),
  })
  await keep.track({ ...input, attemptId: 'vanished-plan' })
  await shared.manager.tick()
  await shared.persistence.drain()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reports).toEqual([
    { kind: 'cache_warm_stopped', at: now, reason: 'session-ended' },
  ])
})
