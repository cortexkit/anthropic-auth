import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  CACHE_KEEP_MAX_BODY_BYTES,
  type CacheKeepManager,
  getLogLevel,
  type LogTestRecord,
  type NativeAccountRuntime,
  resolveNativePoolPaths,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { createNativeAnthropicAdapter } from '../v2/adapter'
import { createNativeCacheKeep } from '../v2/cachekeep'
import { createNativeAnthropicSource, type NativeSource } from '../v2/source'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type PreparedInput = Parameters<
  NonNullable<NativeSource['onRequestPrepared']>
>[0]
type Prepared = { -readonly [K in keyof PreparedInput]: PreparedInput[K] }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'oc2-cachekeep-skips-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const level = getLogLevel()
  const logs: LogTestRecord[] = []
  setLogLevel('debug')
  __setLogTestSink((record) => logs.push(record))
  cleanups.push(() => {
    __setLogTestSink(null)
    setLogLevel(level)
  })
  let now = Date.now()
  const binding = {
    storageId: randomUUID(),
    rowId: 'first',
    credentialEpoch: 0,
  }
  const policy = {
    version: 1,
    accounts: [],
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }
  const account = {
    id: 'first',
    accountIdentity: '11111111-2222-4333-8444-555555555555' as
      | string
      | undefined,
    binding,
    credentialId: 'credential-first',
    source: 'local',
  }
  let child = false
  let lookupFails = false
  let stopDuringRead = false
  let stopDuringLookup = false
  const runtime = {
    drainRoutingPublications: async () => {},
    read: async () => {
      if (stopDuringRead) await keep.dispose()
      return { accounts: [account], policyStorage: policy }
    },
  } as unknown as NativeAccountRuntime
  const keep = createNativeCacheKeep({
    runtime,
    source: {} as NativeSource,
    storageId: binding.storageId,
    registryDirectory: directory,
    now: () => now,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
    isSubagent: async () => {
      if (stopDuringLookup) await keep.dispose()
      if (lookupFails) throw new Error('PRIVATE host error')
      return child
    },
  })
  // Another live instance keeps the shared registry visible even when the
  // instance being tested is stopped during a tracking attempt.
  const observer = createNativeCacheKeep({
    runtime,
    source: {} as NativeSource,
    storageId: binding.storageId,
    registryDirectory: directory,
    now: () => now,
  })
  cleanups.push(async () => {
    now += 2 * 3600_000
    await observer.dispose()
    await keep.dispose()
  })
  const input = {
    sessionID: 'ses_skipped',
    attemptId: 'attempt-first',
    route: 'oauth',
    agent: 'build',
    kind: 'primary',
    accountId: 'first',
    url: 'https://api.anthropic.com/v1/messages',
    bodyText: '{"system":"PRIVATE"}',
    provenance: { kind: 'local', subject: { binding } },
  } as Prepared
  return {
    runtime,
    directory,
    keep,
    input,
    logs,
    policy,
    account,
    manager: (globalThis as any)[
      Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v2')
    ].get(binding.storageId).manager as CacheKeepManager,
    accept: async () => {
      keep.onResponseHeaders({ attemptId: input.attemptId, status: 200 })
      await keep.registry.list()
    },
    child: () => {
      child = true
    },
    lookupFails: () => {
      lookupFails = true
    },
    stopDuringRead: () => {
      stopDuringRead = true
    },
    stopDuringLookup: () => {
      stopDuringLookup = true
    },
  }
}

test.each([
  'lease-stopped',
  'not-oauth',
  'cachekeep-agent',
  'prime-agent',
  'not-primary',
  'session-lookup-failed',
  'subagents-disabled',
  'account-identity-missing',
  'local-binding-changed',
  'vault-credential-changed',
  'stopped-during-read',
  'stopped-during-lookup',
])(
  'OpenCode 2 tracking skip stays quiet and retains the existing target: %s',
  async (path) => {
    const f = await fixture()
    await f.keep.track(f.input)
    await f.accept()
    const tracked = await f.keep.registry.list()
    expect(tracked).toHaveLength(1)
    f.logs.length = 0
    switch (path) {
      case 'lease-stopped':
        await f.keep.dispose()
        break
      case 'not-oauth':
        f.input.route = 'api'
        break
      case 'cachekeep-agent':
        f.input.agent = 'cachekeep'
        break
      case 'prime-agent':
        f.input.agent = 'prime'
        break
      case 'not-primary':
        f.input.kind = 'auxiliary' as Prepared['kind']
        break
      case 'session-lookup-failed':
        f.lookupFails()
        break
      case 'subagents-disabled':
        f.child()
        break
      case 'account-identity-missing':
        f.account.accountIdentity = undefined
        break
      case 'local-binding-changed':
        f.account.binding = { ...f.account.binding, credentialEpoch: 1 }
        break
      case 'vault-credential-changed':
        f.input.provenance = {
          kind: 'vault',
          credentialId: 'replaced',
        } as Prepared['provenance']
        break
      case 'stopped-during-read':
        f.stopDuringRead()
        break
      case 'stopped-during-lookup':
        f.stopDuringLookup()
        break
    }
    await f.keep.track(f.input)
    expect(f.logs).toHaveLength(1)
    expect(f.logs[0]).toMatchObject({
      level: 'debug',
      channel: 'cachekeep',
      message: 'tracking skipped',
      payload: {
        session: 'ses_skipped',
        reason: path.endsWith('-agent')
          ? 'background-agent'
          : path.startsWith('stopped-during-')
            ? 'lease-stopped'
            : path,
      },
    })
    expect(f.logs.filter((record) => record.level === 'warn')).toEqual([])
    expect(await f.keep.registry.list()).toEqual(tracked)
    expect(JSON.stringify(f.logs)).not.toContain('PRIVATE')
  },
)

test('OpenCode 2 manager refusal reports its returned reason once, not just debug', async () => {
  const f = await fixture()
  await f.keep.track(f.input)
  await f.accept()
  const tracked = await f.keep.registry.list()
  f.logs.length = 0
  f.input.bodyText = 'é'.repeat(CACHE_KEEP_MAX_BODY_BYTES / 2 + 1)
  await f.keep.track(f.input)
  await f.accept()
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]).toMatchObject({
    level: 'warn',
    channel: 'cachekeep',
    payload: {
      session: 'ses_skipped',
      reason: 'body-budget',
      detail: 'body exceeds cachekeep memory budget',
      bodyBytes: 67_108_866,
      budgetBytes: 67_108_864,
      targets: 1,
    },
  })
  expect(await f.keep.registry.list()).toEqual(tracked)
})

test.each([400, 413, 429, 500, 503])(
  'OpenCode 2 HTTP %i discards only its own held body',
  async (status) => {
    const f = await fixture()
    await f.keep.track(f.input)
    await f.accept()
    const before = f.manager.trackedRequest(f.input.sessionID)
    const failed = { ...f.input, attemptId: 'failed', bodyText: 'rejected' }
    const next = {
      ...f.input,
      attemptId: 'next',
      bodyText: 'accepted next step',
    }
    await f.keep.track(failed)
    await f.keep.track(next)
    expect(f.manager.trackedRequest(f.input.sessionID)).toEqual(before)
    f.keep.onResponseHeaders({ ...failed, status })
    expect(f.manager.trackedRequest(f.input.sessionID)).toEqual(before)
    f.keep.onResponseHeaders({ ...next, status: 200 })
    expect(f.manager.trackedRequest(f.input.sessionID)?.bodyText).toBe(
      next.bodyText,
    )
    f.keep.onResponseHeaders({ ...failed, status: 200 })
    expect(f.manager.trackedRequest(f.input.sessionID)?.bodyText).toBe(
      next.bodyText,
    )
  },
)

test('OpenCode 2 thrown transport error ends the held attempt without replacing its target', async () => {
  const f = await fixture()
  await f.keep.track(f.input)
  await f.accept()
  const before = f.manager.trackedRequest(f.input.sessionID)
  const source = createNativeAnthropicSource({
    runtime: f.runtime,
    paths: await resolveNativePoolPaths(join(f.directory, 'accounts.json')),
    requestOptions: () => ({}),
    onRequestPrepared: (input) => f.keep.track(input),
    onResponseHeaders: (input) => {
      f.keep.onResponseHeaders(input)
    },
    onAttemptEnd: (input) => f.keep.discardAttempt(input.attemptId),
  })
  const native = createNativeAnthropicAdapter({ source })
  cleanups.push(async () => {
    native.dispose()
    await source.close()
  })
  const failed = { ...f.input, attemptId: 'transport', bodyText: 'not sent' }
  await source.onRequestPrepared?.(failed)
  const transport = async () => {
    throw new TypeError('connection reset')
  }
  try {
    await transport()
    throw new Error('transport unexpectedly succeeded')
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError)
    await native.adapter.onAttemptEnd?.(
      {
        ...failed,
        data: {
          route: 'oauth',
          provenance: failed.provenance,
          dispatch: 'direct',
        },
      },
      {
        outputStarted: false,
        error: { reason: 'failed', message: 'connection reset' },
      },
    )
  }
  source.quotaFromHeaders?.(new Headers(), { ...failed, status: 200 })
  expect(f.manager.trackedRequest(f.input.sessionID)).toEqual(before)
})

test('OpenCode 2 disposal releases held bodies and their abort listeners', async () => {
  const f = await fixture()
  await f.keep.track(f.input)
  await f.accept()
  const before = f.manager.trackedRequest(f.input.sessionID)
  const listeners = new Set<unknown>()
  const signal = {
    aborted: false,
    addEventListener: (_name: string, listener: unknown) =>
      listeners.add(listener),
    removeEventListener: (_name: string, listener: unknown) =>
      listeners.delete(listener),
  } as unknown as AbortSignal
  const held = { ...f.input, attemptId: 'dispose', bodyText: 'held', signal }
  await f.keep.track(held)
  expect(listeners.size).toBe(1)
  await f.keep.dispose()
  expect(listeners.size).toBe(0)
  f.keep.onResponseHeaders({ ...held, status: 200 })
  expect(f.manager.trackedRequest(f.input.sessionID)).toEqual(before)
})
