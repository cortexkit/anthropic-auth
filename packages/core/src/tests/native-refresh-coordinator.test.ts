import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LockOwnershipError,
  lockPathFor,
  withLock,
} from '@cortexkit/common-auth/fs'
import {
  fingerprintOf,
  POOL_LOCK_DEFAULTS,
  PoolOperationError,
} from '@cortexkit/common-auth/store'

import {
  ClaudeOAuthRefreshError,
  type refreshClaudeOAuthToken,
} from '../auth.ts'
import type {
  ProviderAccountUuid,
  resolveClaudeCodeIdentity,
} from '../claude-code.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshCoordinatorOptions,
  type NativeRefreshObservation,
  type NativeRefreshRestriction,
  nativeAccountProviderLock,
} from '../native-refresh-coordinator.ts'
import {
  captureNativeLocalPoolBinding,
  nativeLocalRefreshJobKey,
} from '../pool-binding.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import {
  createNativePoolStore,
  type NativePoolStoreOptions,
} from '../pool-store.ts'

const roots: string[] = []
const quota = {
  validate: (v: unknown) => typeof v === 'number',
  merge: (_v: unknown, observation: unknown) => observation,
}
const allowed: NativeRefreshRestriction = { status: 'allowed' }

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function credential(id: string) {
  return {
    type: 'oauth' as const,
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: 4_000_000_000_000,
  }
}

function accountUuid(value: string) {
  return value as ProviderAccountUuid
}
const identity: typeof resolveClaudeCodeIdentity = async () => ({
  deviceId: 'device',
  sessionId: 'session',
  accountUuid: accountUuid('A'),
})
const provider: typeof refreshClaudeOAuthToken = async () => ({
  ...credential('new'),
  expiresIn: 3600,
})

async function fixture(seams: Partial<NativePoolStoreOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-refresh-')))
  roots.push(root)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const options = { ...seams, paths, quota }
  const store = createNativePoolStore(options)
  await store.initialize()
  async function row(id: string) {
    const read = await store.read()
    if (read.status !== 'ready') throw new Error('Fixture pool not ready')
    const found = read.rows.find((row) => row.id === id)
    if (!found) throw new Error('Fixture row missing')
    return found
  }
  async function binding(id: string) {
    return captureNativeLocalPoolBinding(paths, await row(id))
  }
  async function add(id: string, account?: string) {
    await store.add({ id, identity: account, credential: credential(id) })
  }
  const observations: NativeRefreshObservation[] = []
  function coordinator(
    overrides: Partial<NativeRefreshCoordinatorOptions> = {},
  ) {
    return createNativeRefreshCoordinator({
      ...options,
      refreshToken: provider,
      resolveIdentity: identity,
      readRestrictions: async () => allowed,
      reconcile: async (event) => {
        observations.push(event)
      },
      ...overrides,
    })
  }
  return { root, paths, store, row, binding, add, observations, coordinator }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('account lock spec uses canonical store and identity, not epoch or row namespace', async () => {
  const a = await fixture()
  const b = await fixture()
  const lock = nativeAccountProviderLock(a.paths, 'A')
  expect(lock).toMatchObject({ path: a.paths.state, ...POOL_LOCK_DEFAULTS })
  expect(lock.name).toStartWith('native-account-provider-')
  expect(lock.name).not.toBe('provider-anthropic')
  expect(lock.name).not.toStartWith('row-')
  expect(nativeAccountProviderLock(a.paths, 'A')).toEqual(lock)
  expect(nativeAccountProviderLock(b.paths, 'A').name).not.toBe(lock.name)
  expect(nativeAccountProviderLock(a.paths, 'B').name).not.toBe(lock.name)
})

test('independent known accounts reach provider concurrently', async () => {
  const active = new Set<string>()
  const events: string[] = []
  const f = await fixture({
    onLockEvent: (event) => {
      if (event.type === 'acquired') active.add(event.name)
      else active.delete(event.name)
      events.push(`${event.type}:${event.name}`)
    },
  })
  await f.add('a', 'A')
  await f.add('b', 'B')
  const both = barrier()
  const finish = barrier()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async (input) => {
      expect(input.maxRetries).toBe(0)
      if (++calls === 2) both.release()
      await finish.promise
      return { ...credential(input.refreshToken), expiresIn: 3600 }
    },
    resolveIdentity: async (access) => ({
      deviceId: 'd',
      sessionId: 's',
      accountUuid: accountUuid(access.endsWith('a') ? 'A' : 'B'),
    }),
  })
  const a = c.refresh({ mode: 'local', binding: await f.binding('a') })
  const b = c.refresh({ mode: 'local', binding: await f.binding('b') })
  await both.promise
  finish.release()
  expect((await a).status).toBe('usable')
  expect((await b).status).toBe('usable')
  expect(calls).toBe(2)
  expect(events).toContain(
    `acquired:${nativeAccountProviderLock(f.paths, 'A').name}`,
  )
  expect(active.size).toBe(0)
})

test('unknown rows serialize under provider-anthropic until reconciliation completes', async () => {
  const f = await fixture()
  await f.add('a')
  await f.add('b')
  const reconciled = barrier()
  const finish = barrier()
  const waiting = barrier()
  let calls = 0
  const c = f.coordinator({
    onLockEvent: (e) => {
      if (e.type === 'acquired' && e.name.includes('row') && calls === 1)
        waiting.release()
    },
    refreshToken: async (input) => {
      calls++
      return { ...credential(input.refreshToken), expiresIn: 3600 }
    },
    resolveIdentity: async () => ({ deviceId: 'd', sessionId: 's' }),
    reconcile: async (e) => {
      if (e.status === 'persisted' && e.binding.rowId === 'a') {
        reconciled.release()
        await finish.promise
      }
    },
  })
  const a = c.refresh({ mode: 'local', binding: await f.binding('a') })
  await reconciled.promise
  const b = c.refresh({ mode: 'local', binding: await f.binding('b') })
  await waiting.promise
  expect(calls).toBe(1)
  finish.release()
  expect((await a).status).toBe('refused')
  expect((await b).status).toBe('refused')
  expect(calls).toBe(2)
})

test('platform instances join identical known jobs but alias waiters never receive another row bearer', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  // The second row has the same account identity. The shared store disables
  // it as a duplicate.
  await f.add('alias', 'A')
  const alias = { ...(await f.binding('a')), rowId: 'alias' }
  const entered = barrier()
  const finish = barrier()
  let calls = 0
  const options = {
    refreshToken: async () => {
      calls++
      entered.release()
      await finish.promise
      return { ...credential('new'), expiresIn: 3600 }
    },
  }
  const c = f.coordinator(options)
  const other = f.coordinator(options)
  const request = { mode: 'local' as const, binding: await f.binding('a') }
  const first = c.refresh(request)
  await entered.promise
  const joined = other.refresh(request)
  const aliasJoined = other.refresh({ ...request, binding: alias })
  finish.release()
  expect(await first).toMatchObject({ status: 'usable', access: 'access-new' })
  expect(await joined).toMatchObject({ status: 'usable', access: 'access-new' })
  expect(await aliasJoined).toMatchObject({
    status: 'refused',
    reason: 'row-ineligible',
  })
  expect((await f.row('alias')).credential).toMatchObject({
    access: 'access-alias',
  })
  expect(calls).toBe(1)
})

test('different canonical stores never share jobs or successors', async () => {
  const a = await fixture()
  const b = await fixture()
  await a.add('a', 'A')
  await b.add('a', 'A')
  const both = barrier()
  const finish = barrier()
  let calls = 0
  function options(label: string) {
    return {
      refreshToken: async () => {
        if (++calls === 2) both.release()
        await finish.promise
        return { ...credential(label), expiresIn: 3600 }
      },
    }
  }
  const first = a
    .coordinator(options('one'))
    .refresh({ mode: 'local', binding: await a.binding('a') })
  const second = b
    .coordinator(options('two'))
    .refresh({ mode: 'local', binding: await b.binding('a') })
  await both.promise
  finish.release()
  expect(await first).toMatchObject({ access: 'access-one' })
  expect(await second).toMatchObject({ access: 'access-two' })
  expect(calls).toBe(2)
})

test('callback-end identity alias joins during reconciliation and handoff encloses publication', async () => {
  const active = new Set<string>()
  const f = await fixture({
    onLockEvent: (e) => {
      if (e.type === 'acquired') active.add(e.name)
      else active.delete(e.name)
    },
  })
  await f.add('a')
  const before = await f.binding('a')
  const entered = barrier()
  const finish = barrier()
  let calls = 0
  let bootstraps = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return { ...credential('new'), expiresIn: 3600 }
    },
    resolveIdentity: async (access, model, account) => {
      expect(access).toBe('access-new')
      expect(model).toBeUndefined()
      expect(account).toBeUndefined()
      bootstraps++
      return { deviceId: 'd', sessionId: 's', accountUuid: accountUuid('A') }
    },
    reconcile: async (e) => {
      expect(e.status).toBe('persisted')
      expect(active.has('provider-anthropic')).toBe(true)
      expect(active.has(nativeAccountProviderLock(f.paths, 'A').name)).toBe(
        true,
      )
      expect(active.has('pool-config')).toBe(false)
      expect(active.has('pool-state')).toBe(false)
      entered.release()
      await finish.promise
    },
  })
  const first = c.refresh({ mode: 'local', binding: before })
  await entered.promise
  // The store already contains account A's identity, but the refresh job has
  // not published its result yet.
  const learnt = await f.binding('a')
  expect(learnt.identity).toBe('A')
  let settled = false
  const joined = c.refresh({ mode: 'local', binding: learnt }).then((r) => {
    settled = true
    return r
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  finish.release()
  expect(await first).toMatchObject({ status: 'usable', binding: learnt })
  expect(await joined).toMatchObject({ status: 'usable', binding: learnt })
  expect(calls).toBe(1)
  expect(bootstraps).toBe(1)
  expect(active.size).toBe(0)
})

test('existing known job retains its alias while unknown handoff waits and both successors persist', async () => {
  const knownReconciling = barrier()
  const unknownBootstrapped = barrier()
  const releaseKnown = barrier()
  const f = await fixture()
  // When both rows identify account A, the shared store keeps the earlier row
  // active and disables the later row.
  await f.add('unknown')
  await f.add('known', 'A')
  const knownBinding = await f.binding('known')
  const unknownBinding = await f.binding('unknown')
  let calls = 0
  const c = f.coordinator({
    refreshToken: async (input) => {
      calls++
      return { ...credential(input.refreshToken), expiresIn: 3600 }
    },
    resolveIdentity: async (access) => {
      if (access.endsWith('unknown')) unknownBootstrapped.release()
      return { deviceId: 'd', sessionId: 's', accountUuid: accountUuid('A') }
    },
    reconcile: async (e) => {
      f.observations.push(e)
      if (e.status === 'persisted' && e.binding.rowId === 'known') {
        knownReconciling.release()
        await releaseKnown.promise
      }
    },
  })
  const known = c.refresh({ mode: 'local', binding: knownBinding })
  await knownReconciling.promise
  const unknown = c.refresh({ mode: 'local', binding: unknownBinding })
  await unknownBootstrapped.promise
  const alias = c.refresh({
    mode: 'local',
    binding: { ...unknownBinding, identity: 'A' },
  })
  releaseKnown.release()
  const knownResult = await known
  const aliasResult = await alias
  const unknownResult = await unknown
  expect(knownResult.status).toBe('usable')
  // The alias row had not been committed when the known row's refresh result
  // was published.
  expect(aliasResult.status).toBe('refused')
  expect(unknownResult.status).toBe('usable')
  expect(calls).toBe(2)
  expect((await f.row('known')).credential).toMatchObject({
    access: 'access-refresh-known',
  })
  expect((await f.row('unknown')).credential).toMatchObject({
    access: 'access-refresh-unknown',
  })
  expect((await f.row('known')).enabled).toBe(false)
  expect(f.observations.filter((e) => e.status === 'persisted')).toHaveLength(2)
})

test('commit-time duplicate disable preserves consumed successor and refuses serving', async () => {
  const f = await fixture()
  await f.add('earlier')
  await f.add('later', 'A')
  const exchanged = barrier()
  const finishExchange = barrier()
  const lateBinding = await f.binding('later')
  const c = f.coordinator({
    refreshToken: async () => {
      exchanged.release()
      await finishExchange.promise
      return { ...credential('successor'), expiresIn: 3600 }
    },
  })
  const refresh = c.refresh({ mode: 'local', binding: lateBinding })
  await exchanged.promise
  await f.store.recordIdentity('earlier', 'A', { credentialEpoch: 1 })
  expect((await f.row('later')).enabled).toBe(false)
  finishExchange.release()
  expect(await refresh).toMatchObject({
    status: 'refused',
    reason: 'row-ineligible',
    persisted: true,
  })
  expect((await f.row('later')).credential).toMatchObject({
    access: 'access-successor',
    refresh: 'refresh-successor',
  })
  expect((await f.row('later')).enabled).toBe(false)
  expect(f.observations).toContainEqual(
    expect.objectContaining({ status: 'persisted' }),
  )
})

test('stale-token 401 adopts pure-store replacement without a provider call and clears old-token restrictions', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const stale = fingerprintOf(credential('a'))
  await f.store.rotate('a', credential('new'))
  let calls = 0
  let blocked = true
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      throw new Error('No refresh allowed')
    },
    readRestrictions: async () =>
      blocked
        ? {
            status: 'blocked',
            reason: 'invalid-grant',
            credentialFingerprint: stale,
          }
        : allowed,
    reconcile: async (event) => {
      expect(event.status).toBe('adopted')
      blocked = false
    },
  })
  expect(
    await c.refresh({
      mode: 'local',
      binding,
      rejectedAccessToken: 'access-a',
    }),
  ).toMatchObject({ status: 'usable', source: 'adopted', access: 'access-new' })
  expect(calls).toBe(0)
})

test('adoption is per-caller and never serves the access token that caller rejected', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  await f.store.rotate('a', credential('new'))
  const entered = barrier()
  const finish = barrier()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
    reconcile: async (e) => {
      expect(e.status).toBe('adopted')
      entered.release()
      await finish.promise
    },
  })
  const first = c.refresh({
    mode: 'local',
    binding,
    rejectedAccessToken: 'access-a',
  })
  await entered.promise
  const joined = c.refresh({
    mode: 'local',
    binding,
    rejectedAccessToken: 'access-new',
  })
  finish.release()
  expect(await first).toMatchObject({
    status: 'usable',
    source: 'adopted',
    access: 'access-new',
  })
  expect(await joined).toMatchObject({
    status: 'refused',
    reason: 'rejected-access-unchanged',
  })
  expect(calls).toBe(0)
})

test('same-token invalid grant and identity-unproven restrictions cannot be cleared by adoption', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  await f.store.rotate('a', credential('new'))
  let calls = 0
  for (const restriction of [
    {
      status: 'blocked',
      reason: 'invalid-grant',
      credentialFingerprint: fingerprintOf(credential('new')),
    },
    { status: 'blocked', reason: 'identity-unproven' },
  ] satisfies NativeRefreshRestriction[]) {
    const c = f.coordinator({
      refreshToken: async () => {
        calls++
        return provider({ refreshToken: 'x' })
      },
      readRestrictions: async () => restriction,
    })
    expect(
      await c.refresh({
        mode: 'local',
        binding,
        rejectedAccessToken: 'access-a',
      }),
    ).toMatchObject({ status: 'refused', reason: restriction.reason })
  }
  expect(calls).toBe(0)
  expect(f.observations.map((e) => e.status)).toEqual(['refused', 'refused'])
})

test('custody, stale epoch and pre-exchange cancellation refuse without provider calls', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const abort = new AbortController()
  abort.abort()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
  })
  expect(await c.refresh({ mode: 'claustrum', binding })).toMatchObject({
    reason: 'custody-mode',
  })
  expect(
    await c.refresh({ mode: 'local', binding, signal: abort.signal }),
  ).toMatchObject({ reason: 'cancelled' })
  await f.store.replace('a', credential('replacement'), { identity: 'A' })
  expect(await c.refresh({ mode: 'local', binding })).toMatchObject({
    reason: 'binding-changed',
  })
  expect(calls).toBe(0)
})

test('cancellation while waiting for physical locks is revalidated before exchange', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const locked = barrier()
  const finish = barrier()
  const abort = new AbortController()
  const spec = nativeAccountProviderLock(f.paths, 'A')
  const holder = withLock(
    spec.path,
    { ...POOL_LOCK_DEFAULTS, name: spec.name },
    async () => {
      locked.release()
      await finish.promise
    },
  )
  await locked.promise
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
  })
  const result = c.refresh({
    mode: 'local',
    binding: await f.binding('a'),
    signal: abort.signal,
  })
  abort.abort()
  finish.release()
  await holder
  expect(await result).toMatchObject({ status: 'refused', reason: 'cancelled' })
  expect(calls).toBe(0)
})

test('after-exchange cancellation persists successor through bootstrap barrier and serves nobody cancelled', async () => {
  const f = await fixture()
  await f.add('a')
  const abort = new AbortController()
  const bootstrapping = barrier()
  const finish = barrier()
  const c = f.coordinator({
    resolveIdentity: async () => {
      bootstrapping.release()
      await finish.promise
      return { deviceId: 'd', sessionId: 's', accountUuid: accountUuid('A') }
    },
  })
  const request = c.refresh({
    mode: 'local',
    binding: await f.binding('a'),
    signal: abort.signal,
  })
  await bootstrapping.promise
  abort.abort()
  finish.release()
  expect(await request).toMatchObject({
    status: 'refused',
    reason: 'cancelled',
    persisted: true,
  })
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
  expect(f.observations).toContainEqual(
    expect.objectContaining({
      status: 'persisted',
      handoff: 'skipped-cancelled',
    }),
  )
})

test('after-exchange bootstrap failure is token-free, durable and non-serving without retry', async () => {
  const f = await fixture()
  await f.add('a')
  const bootstrapping = barrier()
  const finish = barrier()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
    resolveIdentity: async () => {
      bootstrapping.release()
      await finish.promise
      throw new Error('ECONNRESET access-new refresh-new')
    },
  })
  const request = c.refresh({ mode: 'local', binding: await f.binding('a') })
  await bootstrapping.promise
  finish.release()
  expect(await request).toMatchObject({
    status: 'refused',
    reason: 'identity-unproven',
    persisted: true,
  })
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
  expect(f.observations).toContainEqual(
    expect.objectContaining({ status: 'persisted', bootstrap: 'failed' }),
  )
  expect(JSON.stringify(f.observations)).not.toContain('access-new')
  expect(JSON.stringify(f.observations)).not.toContain('refresh-new')
  expect(calls).toBe(1)
})

test('identity contradiction is durably quarantined with old identity, no persisted hook and no retry', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
    resolveIdentity: async () => ({
      deviceId: 'd',
      sessionId: 's',
      accountUuid: accountUuid('B'),
    }),
  })
  expect(
    await c.refresh({ mode: 'local', binding: await f.binding('a') }),
  ).toEqual({
    status: 'identity-contradicted',
    expectedIdentity: 'A',
    returnedIdentity: 'B',
    persisted: true,
  })
  expect(await f.row('a')).toMatchObject({
    identity: 'A',
    enabled: false,
    credential: credential('new'),
  })
  expect(f.observations.map((e) => e.status)).toEqual(['identity-contradicted'])
  await expect(f.store.enable('a')).rejects.toMatchObject({
    kind: 'identity-contradicted',
  })
  await f.store.replace('a', credential('verified'), { identity: 'A' })
  expect((await f.row('a')).enabled).toBe(false)
  await f.store.enable('a')
  expect((await f.row('a')).enabled).toBe(true)
  expect(calls).toBe(1)
})

test('crash-forward contradiction write remains quarantined without ordinary reconciliation', async () => {
  let failConfig = false
  const f = await fixture({
    onStep: (step, info) => {
      if (
        failConfig &&
        info.operation === 'refresh' &&
        step === 'before-config-write'
      )
        throw new Error('synthetic interruption')
    },
  })
  await f.add('a', 'A')
  const binding = await f.binding('a')
  failConfig = true
  const c = f.coordinator({
    resolveIdentity: async () => ({
      deviceId: 'd',
      sessionId: 's',
      accountUuid: accountUuid('B'),
    }),
  })
  expect(await c.refresh({ mode: 'local', binding })).toMatchObject({
    status: 'failed',
    persisted: true,
  })
  expect(await f.row('a')).toMatchObject({
    identity: 'A',
    enabled: false,
    candidate: false,
    credential: credential('new'),
  })
  expect(f.observations.map((e) => e.status)).toEqual(['failed'])
  failConfig = false
  await expect(f.store.enable('a')).rejects.toMatchObject({
    kind: 'identity-contradicted',
  })
  expect((await f.row('a')).enabled).toBe(false)
})

test('persisted reconciliation failure preserves committed fact and cleans learned registration and lease', async () => {
  const f = await fixture()
  await f.add('a')
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
    reconcile: async (e) => {
      f.observations.push(e)
      throw new Error('publisher failed')
    },
  })
  const result = await c.refresh({
    mode: 'local',
    binding: await f.binding('a'),
  })
  expect(result).toMatchObject({
    status: 'failed',
    persisted: true,
    reconciliationFailed: true,
  })
  if (result.status !== 'failed') throw new Error('Expected failure')
  expect(result.error).toBeInstanceOf(PoolOperationError)
  expect(result.error).toMatchObject({
    kind: 'after-persist-hook',
    committed: credential('new'),
  })
  expect(f.observations.map((e) => e.status)).toEqual(['persisted', 'failed'])
  expect(calls).toBe(1)
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
  // After disposal removes the old job registration, a refresh for the newly
  // learned account must use a different job.
  expect(
    await f.coordinator().refresh({
      mode: 'local',
      binding: await f.binding('a'),
      rejectedAccessToken: 'old',
    }),
  ).toMatchObject({ status: 'usable', source: 'adopted' })
  const spec = nativeAccountProviderLock(f.paths, 'A')
  await withLock(
    spec.path,
    { ...POOL_LOCK_DEFAULTS, name: spec.name },
    async (lock) => {
      await lock.assertOwned()
    },
  )
})

test('handoff ownership loss is non-fatal and removes only the unknown job registration', async () => {
  let breakHandoff = true
  const f = await fixture({
    onLockEvent: (e) => {
      if (
        breakHandoff &&
        e.type === 'acquired' &&
        e.name.startsWith('native-account-provider')
      ) {
        breakHandoff = false
        throw new LockOwnershipError({ target: e.path, name: e.name })
      }
    },
  })
  await f.add('a')
  expect(
    await f
      .coordinator()
      .refresh({ mode: 'local', binding: await f.binding('a') }),
  ).toMatchObject({ status: 'usable', access: 'access-new' })
  expect(f.observations).toContainEqual(
    expect.objectContaining({ status: 'persisted', handoff: 'skipped-loss' }),
  )
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
})

test('lost handoff after callback end persists successor, skips registration and releases ownership', async () => {
  const f = await fixture()
  await f.add('a')
  const spec = nativeAccountProviderLock(f.paths, 'A')
  let handoffOwner: string | undefined
  const c = f.coordinator({
    onLockEvent: (e) => {
      if (e.type === 'acquired' && e.name === spec.name) handoffOwner = e.name
    },
    onStep: async (step, info) => {
      if (step === 'before-state-write' && info.operation === 'refresh') {
        expect(handoffOwner).toBe(spec.name)
        // Replace the recorded lock owner to simulate takeover. Keep the normal
        // lease duration and renewal interval unchanged.
        const path = lockPathFor(spec.path, spec.name)
        const bytes = JSON.parse(await readFile(path, 'utf8'))
        bytes.ownerId = 'synthetic-successor-owner'
        await writeFile(path, JSON.stringify(bytes))
      }
    },
  })
  const result = await c.refresh({
    mode: 'local',
    binding: await f.binding('a'),
  })
  expect(result).toMatchObject({ status: 'usable' })
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
  expect(f.observations).toContainEqual(
    expect.objectContaining({ status: 'persisted', handoff: 'skipped-loss' }),
  )
  // Releasing the original owner must not remove the lock file now owned by
  // its replacement.
  expect(
    JSON.parse(await readFile(lockPathFor(spec.path, spec.name), 'utf8'))
      .ownerId,
  ).toBe('synthetic-successor-owner')
})

test('cancelled unknown predecessor cannot dispose an existing known registration or its waiters', async () => {
  const f = await fixture()
  await f.add('known', 'A')
  await f.add('unknown')
  const knownBinding = await f.binding('known')
  const unknownBinding = await f.binding('unknown')
  const entered = barrier()
  const finish = barrier()
  const abort = new AbortController()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async (input) => {
      calls++
      return { ...credential(input.refreshToken), expiresIn: 3600 }
    },
    resolveIdentity: async (access) => {
      if (access.endsWith('unknown')) abort.abort()
      return identity(access, undefined, undefined)
    },
    reconcile: async (e) => {
      if (e.status === 'persisted' && e.binding.rowId === 'known') {
        entered.release()
        await finish.promise
      }
    },
  })
  const known = c.refresh({ mode: 'local', binding: knownBinding })
  await entered.promise
  const unknown = await c.refresh({
    mode: 'local',
    binding: unknownBinding,
    signal: abort.signal,
  })
  expect(unknown).toMatchObject({
    status: 'refused',
    reason: 'cancelled',
    persisted: true,
  })
  let settled = false
  const waiter = c
    .refresh({ mode: 'local', binding: knownBinding })
    .then((r) => {
      settled = true
      return r
    })
  // A new job reads restrictions before proceeding. A caller joining an
  // existing job instead waits for that job's pending reconciliation.
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  finish.release()
  expect((await known).status).toBe('usable')
  expect((await waiter).status).toBe('usable')
  expect(calls).toBe(2)
})

test('cancelled alias waiter leaves owner job running and later waiters join it', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const entered = barrier()
  const finish = barrier()
  const abort = new AbortController()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      entered.release()
      await finish.promise
      return provider({ refreshToken: 'x' })
    },
  })
  const owner = c.refresh({ mode: 'local', binding })
  await entered.promise
  const cancelled = c.refresh({ mode: 'local', binding, signal: abort.signal })
  abort.abort()
  const later = c.refresh({ mode: 'local', binding })
  finish.release()
  expect((await owner).status).toBe('usable')
  expect(await cancelled).toMatchObject({
    status: 'refused',
    reason: 'cancelled',
    persisted: true,
  })
  expect((await later).status).toBe('usable')
  expect(calls).toBe(1)
})

test('refusal and failure reconciliation run outside store locks and finish before job completion', async () => {
  const active = new Set<string>()
  const f = await fixture({
    onLockEvent: (e) => {
      if (e.type === 'acquired') active.add(e.name)
      else active.delete(e.name)
    },
  })
  await f.add('a', 'A')
  const entered = barrier()
  const finish = barrier()
  let settled = false
  const c = f.coordinator({
    readRestrictions: async () => {
      expect(active.has('pool-config')).toBe(false)
      expect(active.has('pool-state')).toBe(false)
      return { status: 'blocked', reason: 'quota-ineligible' }
    },
    reconcile: async (e) => {
      expect(e.status).toBe('refused')
      expect(active.has('pool-config')).toBe(false)
      expect(active.has('pool-state')).toBe(false)
      entered.release()
      await finish.promise
    },
  })
  const result = c
    .refresh({ mode: 'local', binding: await f.binding('a') })
    .then((r) => {
      settled = true
      return r
    })
  await entered.promise
  expect(settled).toBe(false)
  finish.release()
  expect(await result).toMatchObject({
    status: 'refused',
    reason: 'quota-ineligible',
  })
  const failed = f.coordinator({
    refreshToken: async () => {
      throw new ClaudeOAuthRefreshError(400, 'invalid_grant')
    },
    reconcile: async (e) => {
      expect(e.status).toBe('failed')
      expect(active.size).toBe(0)
    },
  })
  expect(
    (await failed.refresh({ mode: 'local', binding: await f.binding('a') }))
      .status,
  ).toBe('failed')
})

test('policy hook failure before endpoint is not a physical transient retry', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let reads = 0
  let calls = 0
  const c = f.coordinator({
    readRestrictions: async () => {
      if (++reads === 2) throw new Error('ECONNRESET')
      return allowed
    },
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
  })
  expect(
    await c.refresh({ mode: 'local', binding: await f.binding('a') }),
  ).toMatchObject({ status: 'failed', persisted: false })
  expect(f.observations.at(-1)).toMatchObject({
    status: 'failed',
    failure: { kind: 'caller-hook', classification: 'permanent' },
  })
  expect(calls).toBe(0)
})

test('strict stamp loss before capture refuses without provider, legacy fallback or repair', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
  delete state.accounts.a.commonAuthPool
  await writeFile(f.paths.state, JSON.stringify(state))
  const before = await readFile(f.paths.state, 'utf8')
  await writeFile(
    f.paths.legacyState,
    JSON.stringify({ access: 'host-access', refresh: 'host-refresh' }),
  )
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
  })
  expect(await c.refresh({ mode: 'local', binding })).toMatchObject({
    status: 'refused',
    reason: 'binding-changed',
  })
  expect(calls).toBe(0)
  expect(await readFile(f.paths.state, 'utf8')).toBe(before)
})

test(
  'handoff published timeout is non-fatal and a consumed successor stays durable',
  async () => {
    const f = await fixture()
    await f.add('a')
    const spec = nativeAccountProviderLock(f.paths, 'A')
    const locked = barrier()
    const finish = barrier()
    const holder = withLock(
      spec.path,
      { ...POOL_LOCK_DEFAULTS, name: spec.name },
      async () => {
        locked.release()
        await finish.promise
      },
    )
    await locked.promise
    try {
      const result = await f
        .coordinator()
        .refresh({ mode: 'local', binding: await f.binding('a') })
      expect(result).toMatchObject({ status: 'usable' })
      expect((await f.row('a')).credential).toMatchObject(credential('new'))
      expect(f.observations).toContainEqual(
        expect.objectContaining({
          status: 'persisted',
          handoff: 'skipped-contention',
        }),
      )
    } finally {
      finish.release()
      await holder
    }
    expect(
      await f.coordinator().refresh({
        mode: 'local',
        binding: await f.binding('a'),
        rejectedAccessToken: 'old',
      }),
    ).toMatchObject({ status: 'usable', source: 'adopted' })
    // Allow for the store's 15-second lock wait. The test does not shorten the
    // lock timeout, lease duration or renewal interval.
  },
  POOL_LOCK_DEFAULTS.timeoutMs + 5_000,
)

test('commit dispatch-material fence refuses a same-epoch foreign edit after exchange', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const bootstrapping = barrier()
  const finish = barrier()
  const c = f.coordinator({
    resolveIdentity: async () => {
      bootstrapping.release()
      await finish.promise
      return identity('x', undefined, undefined)
    },
  })
  const request = c.refresh({ mode: 'local', binding: await f.binding('a') })
  await bootstrapping.promise
  const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
  state.accounts.a.access = 'foreign'
  await writeFile(f.paths.state, JSON.stringify(state))
  finish.release()
  expect(await request).toMatchObject({ status: 'failed', persisted: false })
  expect((await f.row('a')).stamp).toBe('mismatched')
  expect(await readFile(f.paths.state, 'utf8')).not.toContain('access-new')
})

for (const [name, cause, expectedCalls, classification] of [
  [
    'persistent 5xx',
    new ClaudeOAuthRefreshError(503, 'unavailable'),
    3,
    'transient',
  ],
  [
    'transient network',
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    3,
    'transient',
  ],
  [
    'invalid_grant',
    new ClaudeOAuthRefreshError(400, '{"error":"invalid_grant"}'),
    1,
    'invalid-grant',
  ],
  [
    'invalid_grant even on 5xx',
    new ClaudeOAuthRefreshError(503, 'invalid_grant'),
    1,
    'invalid-grant',
  ],
  ['rate limit', new ClaudeOAuthRefreshError(429, 'busy', '7'), 1, 'permanent'],
  [
    'permanent network',
    new Error('certificate validation failed'),
    1,
    'permanent',
  ],
] as const) {
  test(`${name} has exactly bounded physical calls and retains the original classified cause`, async () => {
    let captures = 0
    const f = await fixture({
      hold: () => {
        captures++
      },
    })
    await f.add('a', 'A')
    let calls = 0
    const c = f.coordinator({
      refreshToken: async (input) => {
        expect(input.maxRetries).toBe(0)
        calls++
        throw cause
      },
    })
    const result = await c.refresh({
      mode: 'local',
      binding: await f.binding('a'),
    })
    expect(result).toMatchObject({ status: 'failed', persisted: false })
    if (result.status !== 'failed') throw new Error('Expected failed result')
    expect(result.error.cause).toBe(cause)
    expect(calls).toBe(expectedCalls)
    expect(captures).toBe(expectedCalls)
    expect(f.observations).toHaveLength(expectedCalls)
    expect(f.observations.at(-1)).toMatchObject({
      status: 'failed',
      failure: { kind: 'provider', classification },
    })
    expect((await f.row('a')).credential).toMatchObject(credential('a'))
  })
}

test('same-token backoff reconciled after a transient attempt prevents the next physical call', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let restriction: NativeRefreshRestriction = allowed
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      throw new ClaudeOAuthRefreshError(503, 'unavailable')
    },
    readRestrictions: async () => restriction,
    reconcile: async (e) => {
      if (e.status === 'failed')
        restriction = {
          status: 'blocked',
          reason: 'refresh-backoff',
          credentialFingerprint: e.credentialFingerprint!,
        }
    },
  })
  expect(
    await c.refresh({ mode: 'local', binding: await f.binding('a') }),
  ).toMatchObject({ status: 'refused', reason: 'refresh-backoff' })
  expect(calls).toBe(1)
})

test('restriction change after exchange cannot discard rotation but does prevent serving', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let restriction: NativeRefreshRestriction = allowed
  const guarded = f.coordinator({
    readRestrictions: async () => restriction,
    resolveIdentity: async () => {
      restriction = { status: 'blocked', reason: 'quota-ineligible' }
      return identity('x', undefined, undefined)
    },
  })
  expect(
    await guarded.refresh({ mode: 'local', binding: await f.binding('a') }),
  ).toMatchObject({
    status: 'refused',
    reason: 'quota-ineligible',
    persisted: true,
  })
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
})

test('epoch-separated job cannot join an old job, and old terminal cleanup cannot erase the next job', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const oldBinding = await f.binding('a')
  const oldReconciling = barrier()
  const finishOld = barrier()
  const nextEntered = barrier()
  const finishNext = barrier()
  let calls = 0
  const c = f.coordinator({
    refreshToken: async () => {
      calls++
      if (calls === 2) {
        nextEntered.release()
        await finishNext.promise
      }
      return { ...credential(`new-${calls}`), expiresIn: 3600 }
    },
    reconcile: async (e) => {
      if (e.status === 'persisted' && e.binding.credentialEpoch === 1) {
        oldReconciling.release()
        await finishOld.promise
      }
    },
  })
  const first = c.refresh({ mode: 'local', binding: oldBinding })
  await oldReconciling.promise
  // Check that a new credential version produces a different refresh-job key
  // before replacement acquires the row lock.
  const nextBinding = { ...oldBinding, credentialEpoch: 2 }
  expect(nativeLocalRefreshJobKey(nextBinding)).not.toBe(
    nativeLocalRefreshJobKey(oldBinding),
  )
  const premature = await c.refresh({ mode: 'local', binding: nextBinding })
  expect(premature).toMatchObject({
    status: 'refused',
    reason: 'binding-changed',
  })
  finishOld.release()
  expect((await first).status).toBe('usable')
  await f.store.replace('a', credential('replacement'), { identity: 'A' })
  const next = c.refresh({ mode: 'local', binding: await f.binding('a') })
  await nextEntered.promise
  const joined = c.refresh({ mode: 'local', binding: await f.binding('a') })
  finishNext.release()
  expect((await next).status).toBe('usable')
  expect((await joined).status).toBe('usable')
  expect(calls).toBe(2)
})
