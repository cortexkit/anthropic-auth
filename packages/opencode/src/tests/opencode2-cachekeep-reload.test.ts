import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CacheKeepManager,
  CacheKeepSessionRegistry,
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
  'OpenCode 2 reload tracks a response through a 2.5.3 shared owner (retained: %s)',
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
        accounts: [{ id: 'first', accountIdentity, binding }],
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
    // The published 2.5.3 registry knows only the original three fields.
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
      onTargetRemoved: (id) => owner.persistence.removed(id),
    })
    cleanups.push(() => manager.stop())
    const target = {
      sessionId: 'ses_before_reload',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: '{"system":"Keep this prefix"}',
      storage: policy,
      cacheMode: 'hybrid' as const,
      oauthAccountId: 'first',
      oauthAccountIdentity: accountIdentity,
    }
    // Expose the old manager surface, not its new registrySessions method or
    // reason-aware untrack signature, even though the backing scheduler is current.
    const legacyManager = {
      track: manager.track.bind(manager),
      trackedSessions: manager.trackedSessions.bind(manager),
      untrack: (id: string) => manager.untrack(id),
    }
    const owner = {
      manager: legacyManager,
      registry,
      persistence,
      persistenceFollowsOwner: true,
      prepared: new Map(),
      leases: new Map(retained ? [] : [[0, { stopped: false }]]),
      nextGeneration: 1,
      retain: () => manager.stop(),
      adopt: async () => {
        manager.start()
        await registry.publish(manager.trackedSessions())
      },
    }
    expect(manager.track(target).tracked).toBe(true)
    if (!retained) manager.start()
    const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    const scope = globalThis as any
    scope[key] ??= new Map()
    const shared = scope[key]
    shared.set(storageId, owner)
    cleanups.push(() => shared.delete(storageId))
    const keep = createNativeCacheKeep({
      storageId,
      runtime,
      source: {} as NativeSource,
      persistence: { root: directory },
      now: () => now,
    })
    cleanups.push(() => keep.dispose())
    await keep.ready
    expect(shared.get(storageId)).toBe(owner)
    expect(keep.registry === (registry as unknown)).toBe(true)
    expect(timers.size).toBe(1)
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
    expect(await registry.list()).toEqual(
      ['ses_after_reload', 'ses_before_reload'].map((id) => ({
        id,
        cacheExpiresAt: now + 3_600_000,
        nextPrewarmAt: now + 3_300_000,
      })),
    )
    expect(timers.size).toBe(1)
    keep.forgetSession('ses_before_reload')
    expect(manager.trackedSessions().map(({ id }) => id)).toEqual([
      'ses_after_reload',
    ])
    policy.cacheKeep = { enabled: false }
    await keep.track({
      sessionID: 'ses_disabled',
      attemptId: 'disabled',
      route: 'oauth',
      agent: 'build',
      kind: 'primary',
    } as Parameters<typeof keep.track>[0])
    expect(manager.trackedSessions()).toEqual([])
    await owner.persistence.drain()
    expect(await readdir(owner.persistence.directory)).toEqual([])
  },
)

test('OpenCode 2 hybrid disable removes local records but preserves a mixed store runner target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-mixed-'))
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
  const shared = (globalThis as any)[
    Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
  ].get(storageId)
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
  policy.cacheKeep = { enabled: false }
  await keep.track({ ...input, attemptId: 'disabled' })
  await shared.persistence.drain()
  expect(
    shared.manager.trackedSessions().map(({ id }: { id: string }) => id),
  ).toEqual(['ses_runner'])
  const retained: string[] = []
  await shared.persistence.load(now, (entry: { id: string }) => {
    retained.push(entry.id)
    return undefined
  })
  expect(retained).toEqual(['ses_runner'])
  expect(
    (await readdir(shared.persistence.directory)).filter((name) =>
      name.endsWith('.json.gz'),
    ),
  ).toHaveLength(1)
})
