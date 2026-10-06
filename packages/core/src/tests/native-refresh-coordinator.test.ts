import {
  afterEach,
  beforeAll,
  test as bunTest,
  describe,
  expect,
} from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  LockOwnershipError,
  lockPathFor,
  withLock,
} from '@cortexkit/common-auth/fs'
import {
  fingerprintOf,
  POOL_LOCK_DEFAULTS,
  PoolOperationError,
  type PoolRow,
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
  type NativeLocalCredentialValidation,
  nativeLocalCredentialValidationMatches,
} from '../native-credential-validation.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshContext,
  type NativeRefreshCoordinatorOptions,
  type NativeRefreshDispatchVersion,
  type NativeRefreshObservation,
  type NativeRefreshPolicy,
  type NativeRefreshRequest,
  type NativeRefreshRestriction,
  type NativeRefreshResult,
  type NativeRefreshSubject,
  nativeAccountProviderLock,
} from '../native-refresh-coordinator.ts'
import {
  captureNativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
  nativeLocalRefreshJobKey,
} from '../pool-binding.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import {
  createNativePoolStore,
  type NativeLockEvent,
  type NativePoolStoreOptions,
  nativePoolStoreLocks,
} from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { TestLifetime } from './test-lifetime.ts'

const roots: string[] = []
const scenarioRoots = new WeakMap<TestLifetime, Set<string>>()
const physicalChildRoots = new WeakMap<TestLifetime, Set<string>>()
const testLifetime = new AsyncLocalStorage<TestLifetime>()
let currentLifetime: TestLifetime | undefined

function test(
  name: string,
  body: () => void | Promise<void>,
  timeout?: number,
) {
  bunTest(
    name,
    () => {
      const scenario = new TestLifetime()
      currentLifetime = scenario
      return testLifetime.run(scenario, () => scenario.runBody(body))
    },
    timeout,
  )
}

function track<T>(call: Promise<T>): Promise<T> {
  // A Bun deadline can end while the body or its store operations still run.
  // Return the original promise so assertions see any rejection, and separately
  // wait for its settlement before removing the test's pool fixture files.
  testLifetime.getStore()?.trackDetached(
    call.then(
      () => {},
      () => {},
    ),
  )
  return call
}
const quota = {
  validate: (v: unknown) => typeof v === 'number',
  merge: (_v: unknown, observation: unknown) => observation,
}
const allowed: NativeRefreshRestriction = { status: 'allowed' }

function policyFor(
  subject: NativeRefreshSubject,
  restriction = allowed,
): NativeRefreshPolicy {
  return {
    restriction,
    context: {
      subject,
      runtimeBinding: subject.binding,
      refreshErrorClearedAt: null,
      quotaErrorClearedAt: null,
      quotaErrorGeneration: null,
    },
  }
}

function proofFor(
  binding: NativeLocalCredentialValidation['binding'],
  row: PoolRow,
): NativeLocalCredentialValidation {
  const c = row.credential
  if (c?.type !== 'oauth' || !c.access || !c.expires)
    throw new Error('Proof requires OAuth material')
  return {
    binding,
    credentialFingerprint: fingerprintOf(c),
    version: {
      accessFingerprint: tokenFingerprint(c.access),
      expires: c.expires,
      ...(Object.hasOwn(c, 'lastRefreshedAt')
        ? { lastRefreshedAt: c.lastRefreshedAt }
        : {}),
    },
  }
}

type FixtureOverrides = Omit<
  Partial<NativeRefreshCoordinatorOptions>,
  'readRestrictions'
> & {
  readRestrictions?: (
    subject: NativeRefreshSubject,
  ) => Promise<NativeRefreshRestriction | NativeRefreshPolicy>
  publishProof?: boolean
}

function barrier() {
  const scenario = testLifetime.getStore()
  if (scenario) {
    const gate = scenario.gate()
    return { promise: gate.wait, release: gate.open }
  }
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function trackLock(active: Set<string>, event: NativeLockEvent) {
  if (event.type === 'acquired') active.add(event.name)
  else if (event.type === 'released') active.delete(event.name)
}

test('contended diagnostic preserves acquired evidence until explicit release', () => {
  const active = new Set<string>()
  const lock = { name: 'native-account-provider-synthetic', path: '/synthetic' }
  trackLock(active, { type: 'acquired', ...lock })
  expect(active.has(lock.name)).toBe(true)
  trackLock(active, { type: 'contended', ...lock })
  expect(active.has(lock.name)).toBe(true)
  trackLock(active, { type: 'released', ...lock })
  expect(active.has(lock.name)).toBe(false)
})

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
  const scenario = testLifetime.getStore()
  if (scenario) {
    let ownedRoots = scenarioRoots.get(scenario)
    if (!ownedRoots) {
      ownedRoots = new Set()
      scenarioRoots.set(scenario, ownedRoots)
    }
    ownedRoots.add(root)
  } else roots.push(root)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const options = { ...seams, paths, quota }
  const store = new Proxy(createNativePoolStore(options), {
    get(target, property) {
      const member = Reflect.get(target, property)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        const result = Reflect.apply(member, target, args)
        return result instanceof Promise ? track(result) : result
      }
    },
  })
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
  const proofs = new Map<string, NativeLocalCredentialValidation>()
  async function seedProof(id: string) {
    const b = await binding(id)
    if (b.identity === undefined)
      throw new Error('Seeded evidence requires known identity')
    const proof = proofFor({ ...b, identity: b.identity }, await row(id))
    proofs.set(id, proof)
    return proof
  }
  function coordinator(overrides: FixtureOverrides = {}) {
    const coordinator = createNativeRefreshCoordinator({
      ...options,
      refreshToken: provider,
      resolveIdentity: identity,
      ...overrides,
      readRestrictions: async (subject) => {
        const result = (await overrides.readRestrictions?.(subject)) ?? allowed
        return 'restriction' in result ? result : policyFor(subject, result)
      },
      readAdmission:
        overrides.readAdmission ??
        (async (subject) => {
          const proof = proofs.get(subject.binding.rowId)
          return proof
            ? { status: 'proven', validation: proof }
            : { status: 'unproven' }
        }),
      reconcile: async (event) => {
        if (overrides.reconcile) await overrides.reconcile(event)
        else observations.push(event)
        // For newly observed credentials, the fixture saves validation evidence
        // only after a successful provider account lookup and a matching current
        // row binding, refresh lineage and access version. A completed job or an
        // adopted observation cannot create that evidence.
        if (
          overrides.publishProof === false ||
          event.bootstrap !== 'resolved' ||
          (event.status !== 'persisted' &&
            event.status !== 'validation-observed') ||
          !event.identity
        )
          return
        const current = await row(event.binding.rowId)
        const b = { ...event.binding, identity: event.identity }
        const material =
          event.status === 'persisted'
            ? event.committed
            : event.context?.subject
        if (
          !nativeLocalPoolBindingMatches(b, paths, current) ||
          !material ||
          current.fingerprint !== material.credentialFingerprint ||
          !dispatchMatches(material.version, current)
        )
          return
        proofs.set(
          current.id,
          proofFor({ ...b, identity: event.identity }, current),
        )
      },
    })
    return {
      // These tests request a token exchange even when access is unexpired.
      // This helper selects intent: 'refresh'. Production callers use authorize
      // and must choose an exchange or validated access for serving a request.
      refresh: (request: Omit<NativeRefreshRequest, 'intent'>) =>
        track(coordinator.authorize({ ...request, intent: 'refresh' })),
      authorize: (request: NativeRefreshRequest) =>
        track(coordinator.authorize(request)),
    }
  }
  return {
    root,
    paths,
    store,
    row,
    binding,
    add,
    observations,
    coordinator,
    proofs,
    seedProof,
  }
}

afterEach(async () => {
  const scenario = currentLifetime
  traceTimeoutProbe('afterEach:entered')
  const unscopedRoots = roots.splice(0)
  // Bun reports a timeout without cancelling the test body. Open that body's
  // waiting gates, wait for the body and pending store calls, then delete the
  // test's files.
  traceTimeoutProbe('lifetime:finish-start')
  await scenario?.finish()
  traceTimeoutProbe('lifetime:finish-complete')
  await Promise.all(
    [
      ...unscopedRoots,
      ...(scenario ? (scenarioRoots.get(scenario) ?? []) : []),
    ].map((root) => rm(root, { recursive: true, force: true })),
  )
  for (const root of scenario ? (physicalChildRoots.get(scenario) ?? []) : []) {
    tracePhysicalChild('fixture:deleted', root)
  }
  if (timeoutProbePool && timeoutProbeLog) {
    appendFileSync(
      timeoutProbeLog,
      `${JSON.stringify({ event: `cleanup:${++timeoutProbeCleanupCount}`, finallySeen: timeoutProbeFinallySeen, poolExists: existsSync(timeoutProbePool) })}\n`,
    )
  }
})

type VersionedObservation = NativeRefreshObservation & {
  successorVersion?: NativeRefreshDispatchVersion
}

function dispatchMatches(
  version: NativeRefreshDispatchVersion | undefined,
  row: PoolRow,
) {
  const credential = row.credential
  return (
    version !== undefined &&
    credential?.type === 'oauth' &&
    version.accessFingerprint ===
      (credential.access ? tokenFingerprint(credential.access) : undefined) &&
    version.expires === credential.expires &&
    Object.hasOwn(version, 'lastRefreshedAt') ===
      Object.hasOwn(credential, 'lastRefreshedAt') &&
    version.lastRefreshedAt === credential.lastRefreshedAt
  )
}

async function publicationLocks<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  publish: (assertOwned: () => Promise<void>) => Promise<T>,
) {
  const [config, state] = nativePoolStoreLocks(f.paths)
  return withLock(
    config.path,
    { ...POOL_LOCK_DEFAULTS, name: config.name },
    async (configLock) =>
      withLock(
        state.path,
        { ...POOL_LOCK_DEFAULTS, name: state.name },
        async (stateLock) =>
          withLock(
            f.paths.runtime,
            { ...POOL_LOCK_DEFAULTS, name: 'native-runtime' },
            async (runtimeLock) => {
              const assertOwned = async () => {
                await configLock.assertOwned()
                await stateLock.assertOwned()
                await runtimeLock.assertOwned()
              }
              await assertOwned()
              return publish(assertOwned)
            },
          ),
      ),
  )
}

for (const terminal of ['persisted', 'failed'] as const) {
  for (const replacement of ['access-only', 'same-material'] as const) {
    const change =
      replacement === 'access-only'
        ? 'access-only same-epoch rotation'
        : 'a newer refresh stamp with repeated dispatch material'
    test(`${terminal} observation fences ${change} after row and provider lease loss`, async () => {
      const f = await fixture()
      await f.add('a', 'A')
      const binding = await f.binding('a')
      const entered = barrier()
      const release = barrier()
      const finishProvider = barrier()
      const clearMarkers = { refreshErrorClearedAt: 7, quotaErrorClearedAt: 9 }
      let observation: VersionedObservation | undefined
      let freshAccepted = false
      let staleAccepted = false
      let oldFieldsAccepted = false
      await publicationLocks(f, async (assertOwned) => {
        await assertOwned()
        await writeFile(
          f.paths.runtime,
          JSON.stringify({ ...clearMarkers, error: 'older-observation' }),
          { mode: 0o600 },
        )
      })
      let expectedVersion: NativeRefreshDispatchVersion | undefined
      const c = f.coordinator({
        readRestrictions: async (subject) => {
          const native = JSON.parse(await readFile(f.paths.runtime, 'utf8'))
          return {
            ...policyFor(subject),
            context: {
              ...policyFor(subject).context,
              refreshErrorClearedAt: native.refreshErrorClearedAt,
              quotaErrorClearedAt: native.quotaErrorClearedAt,
            },
          }
        },
        refreshToken: async () => {
          if (terminal === 'failed') {
            entered.release()
            await finishProvider.promise
            throw new ClaudeOAuthRefreshError(400, 'invalid_grant')
          }
          return {
            ...credential('a'),
            access: 'access-first-successor',
            expiresIn: 3600,
          }
        },
        reconcile: async (event) => {
          observation = event
          if (terminal === 'persisted') {
            const row = await f.row('a')
            if (row.credential?.type !== 'oauth')
              throw new Error('OAuth fixture required')
            expectedVersion = {
              accessFingerprint: tokenFingerprint('access-first-successor'),
              expires: row.credential.expires,
              lastRefreshedAt: row.credential.lastRefreshedAt,
            }
            freshAccepted = dispatchMatches(observation.successorVersion, row)
            entered.release()
            await release.promise
          }
          await publicationLocks(f, async (assertOwned) => {
            const row = await f.row('a')
            const native = JSON.parse(await readFile(f.paths.runtime, 'utf8'))
            const expectedFingerprint =
              event.status === 'persisted'
                ? event.successorFingerprint
                : event.credentialFingerprint
            oldFieldsAccepted =
              nativeLocalPoolBindingMatches(binding, f.paths, row) &&
              row.fingerprint === expectedFingerprint &&
              native.refreshErrorClearedAt ===
                event.context?.refreshErrorClearedAt &&
              native.quotaErrorClearedAt === event.context?.quotaErrorClearedAt
            const version =
              terminal === 'persisted'
                ? observation?.successorVersion
                : observation?.credentialVersion
            staleAccepted = oldFieldsAccepted && dispatchMatches(version, row)
            if (staleAccepted) {
              await assertOwned()
              await writeFile(
                f.paths.runtime,
                JSON.stringify({
                  ...native,
                  error: 'stale-observation-overwrite',
                }),
                { mode: 0o600 },
              )
            }
          })
        },
      })
      const before = await f.row('a')
      if (before.credential?.type !== 'oauth')
        throw new Error('OAuth fixture required')
      if (terminal === 'failed') {
        expectedVersion = {
          accessFingerprint: tokenFingerprint('access-a'),
          expires: before.credential.expires,
          lastRefreshedAt: before.credential.lastRefreshedAt,
        }
      }
      const job = c.refresh({ mode: 'local', binding })
      await entered.promise
      await unlink(lockPathFor(f.paths.state, 'row-A'))
      const providerLock = nativeAccountProviderLock(f.paths, 'A')
      await unlink(lockPathFor(providerLock.path, providerLock.name))
      await f.store.rotate('a', {
        ...credential('a'),
        access:
          replacement === 'access-only'
            ? 'access-second-successor'
            : terminal === 'persisted'
              ? 'access-first-successor'
              : 'access-a',
      })
      const rotated = await f.row('a')
      expect(rotated).toMatchObject({
        stamp: 'bound',
        credentialEpoch: binding.credentialEpoch,
        identity: binding.identity,
      })
      expect(rotated.fingerprint).toBe(before.fingerprint)
      await publicationLocks(f, async (assertOwned) => {
        await assertOwned()
        await writeFile(
          f.paths.runtime,
          JSON.stringify({ ...clearMarkers, error: 'newer-observation' }),
          { mode: 0o600 },
        )
      })
      release.release()
      finishProvider.release()
      const result = await job
      expect(result.status).toBe(
        terminal === 'persisted' ? 'refused' : 'failed',
      )
      expect(oldFieldsAccepted).toBe(true)
      expect(staleAccepted).toBe(false)
      expect(JSON.parse(await readFile(f.paths.runtime, 'utf8'))).toEqual({
        ...clearMarkers,
        error: 'newer-observation',
      })
      expect(observation).toMatchObject(
        terminal === 'persisted'
          ? { successorVersion: expectedVersion }
          : { credentialVersion: expectedVersion },
      )
      if (terminal === 'persisted') expect(freshAccepted).toBe(true)
      else
        expect(dispatchMatches(observation?.credentialVersion, before)).toBe(
          true,
        )
      expect(
        Object.isFrozen(
          terminal === 'persisted'
            ? observation?.successorVersion
            : observation?.credentialVersion,
        ),
      ).toBe(true)
    })
  }
}

async function waitForProviders(
  entered: Promise<void>,
  jobs: Promise<NativeRefreshResult>[],
  trace: () => string,
) {
  await Promise.race([
    entered,
    ...jobs.map(async (job) => {
      const result = await job
      throw new Error(
        `Refresh ended before both providers entered: ${result.status}\n${trace()}`,
      )
    }),
  ])
}

test('captured clear markers fence a failure even when its dispatch version still matches', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const entered = barrier()
  const release = barrier()
  const capturedMarkers = { refreshErrorClearedAt: 7, quotaErrorClearedAt: 9 }
  await publicationLocks(f, async (assertOwned) => {
    await assertOwned()
    await writeFile(f.paths.runtime, JSON.stringify(capturedMarkers), {
      mode: 0o600,
    })
  })
  let versionMatched = false
  let freshAccepted = false
  let published = false
  const c = f.coordinator({
    readRestrictions: async (subject) => {
      const markers = JSON.parse(await readFile(f.paths.runtime, 'utf8'))
      return {
        ...policyFor(subject),
        context: {
          ...policyFor(subject).context,
          refreshErrorClearedAt: markers.refreshErrorClearedAt,
          quotaErrorClearedAt: markers.quotaErrorClearedAt,
        },
      }
    },
    refreshToken: async () => {
      throw new ClaudeOAuthRefreshError(429, 'busy', '7')
    },
    reconcile: async (event) => {
      if (event.status !== 'failed')
        throw new Error('Failure observation expected')
      const row = await f.row('a')
      const currentMarkers = JSON.parse(await readFile(f.paths.runtime, 'utf8'))
      freshAccepted =
        dispatchMatches(event.credentialVersion, row) &&
        event.context?.refreshErrorClearedAt ===
          currentMarkers.refreshErrorClearedAt
      entered.release()
      await release.promise
      await publicationLocks(f, async () => {
        const row = await f.row('a')
        const currentMarkers = JSON.parse(
          await readFile(f.paths.runtime, 'utf8'),
        )
        versionMatched = dispatchMatches(event.credentialVersion, row)
        published =
          nativeLocalPoolBindingMatches(binding, f.paths, row) &&
          event.credentialFingerprint === row.fingerprint &&
          versionMatched &&
          event.context?.refreshErrorClearedAt ===
            currentMarkers.refreshErrorClearedAt &&
          event.context?.quotaErrorClearedAt ===
            currentMarkers.quotaErrorClearedAt
      })
    },
  })
  const job = c.refresh({ mode: 'local', binding })
  await entered.promise
  await publicationLocks(f, async (assertOwned) => {
    const currentMarkers = JSON.parse(await readFile(f.paths.runtime, 'utf8'))
    currentMarkers.refreshErrorClearedAt++
    await assertOwned()
    await writeFile(f.paths.runtime, JSON.stringify(currentMarkers), {
      mode: 0o600,
    })
  })
  release.release()
  expect((await job).status).toBe('failed')
  expect(freshAccepted).toBe(true)
  expect(versionMatched).toBe(true)
  expect(published).toBe(false)
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
  const started = performance.now()
  const trace: string[] = []
  const phase = (label: string) => {
    trace.push(`${(performance.now() - started).toFixed(2)}ms ${label}`)
  }
  const finish = barrier()
  const jobs: Promise<NativeRefreshResult>[] = []
  const diagnostic = setTimeout(
    () => console.error(`INDEPENDENT-TRACE pending\n${trace.join('\n')}`),
    4_000,
  )
  try {
    phase('fixture:start')
    const active = new Set<string>()
    const events: string[] = []
    const f = await fixture({
      onStep: (step, info) => phase(`${info.operation}:${info.rowId}:${step}`),
      onLockEvent: (event) => {
        phase(`${event.type}:${event.name}`)
        trackLock(active, event)
        events.push(`${event.type}:${event.name}`)
      },
    })
    phase('fixture:initialized')
    phase('add-a:start')
    await f.add('a', 'A')
    phase('add-a:end')
    phase('add-b:start')
    await f.add('b', 'B')
    phase('add-b:end')
    const both = barrier()
    let calls = 0
    const c = f.coordinator({
      refreshToken: async (input) => {
        phase(`provider:${calls + 1}`)
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
    phase('binding-a:start')
    const aBinding = await f.binding('a')
    phase('binding-a:end')
    phase('binding-b:start')
    const bBinding = await f.binding('b')
    phase('binding-b:end/launch-both')
    const a = c.refresh({ mode: 'local', binding: aBinding }).then((result) => {
      phase(`terminal-a:${result.status}`)
      return result
    })
    const b = c.refresh({ mode: 'local', binding: bBinding }).then((result) => {
      phase(`terminal-b:${result.status}`)
      return result
    })
    jobs.push(a, b)
    await waitForProviders(both.promise, jobs, () => trace.join('\n'))
    phase('providers:both')
    finish.release()
    expect((await a).status).toBe('usable')
    expect((await b).status).toBe('usable')
    expect(calls).toBe(2)
    expect(events).toContain(
      `acquired:${nativeAccountProviderLock(f.paths, 'A').name}`,
    )
    expect(active.size).toBe(0)
    phase('complete')
  } catch (error) {
    console.error(`INDEPENDENT-TRACE failed\n${trace.join('\n')}`)
    throw error
  } finally {
    finish.release()
    await Promise.allSettled(jobs)
    clearTimeout(diagnostic)
  }
})

test('concurrency fixture reports terminal refusal and releases the waiting provider before cleanup', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  await f.add('b', 'B')
  const aBinding = await f.binding('a')
  const bBinding = await f.binding('b')
  const entered = barrier()
  const finish = barrier()
  const c = f.coordinator({
    refreshToken: async () => {
      entered.release()
      await finish.promise
      return provider({ refreshToken: 'synthetic' })
    },
    readRestrictions: async (subject) =>
      subject.binding.rowId === 'b'
        ? { status: 'blocked', reason: 'quota-ineligible' }
        : allowed,
  })
  const a = c.refresh({ mode: 'local', binding: aBinding })
  await entered.promise
  const b = c.refresh({ mode: 'local', binding: bBinding })
  const neverBothEntered = barrier()
  try {
    await expect(
      waitForProviders(
        neverBothEntered.promise,
        [a, b],
        () => 'provider-A waiting; row-B refused',
      ),
    ).rejects.toThrow('Refresh ended before both providers entered: refused')
  } finally {
    finish.release()
    await Promise.allSettled([a, b])
  }
  expect((await a).status).toBe('usable')
  expect(await b).toMatchObject({
    status: 'refused',
    reason: 'quota-ineligible',
  })
  const lock = nativeAccountProviderLock(f.paths, 'A')
  await withLock(
    lock.path,
    { ...POOL_LOCK_DEFAULTS, name: lock.name },
    async (owned) => {
      await owned.assertOwned()
    },
  )
})

const timeoutProbePool = process.env.NATIVE_REFRESH_TIMEOUT_POOL
const timeoutProbeLog = process.env.NATIVE_REFRESH_TIMEOUT_LOG
function traceTimeoutProbe(event: string, data: Record<string, unknown> = {}) {
  if (!timeoutProbeLog) return
  appendFileSync(
    timeoutProbeLog,
    `${JSON.stringify({ event, at: Date.now(), monotonic: performance.now(), ...data })}\n`,
  )
}
let timeoutProbeFinallySeen = false
let timeoutProbeCleanupCount = 0
if (timeoutProbePool && timeoutProbeLog) {
  describe('runner timeout probe', () => {
    const entered = barrier()
    const release = barrier()
    let job: Promise<NativeRefreshResult>
    const record = (
      event: string,
      data: Record<string, string | boolean> = {},
    ) => {
      traceTimeoutProbe(event, data)
    }
    beforeAll(async () => {
      roots.push(timeoutProbePool)
      const paths = await resolveNativePoolPaths(
        join(timeoutProbePool, 'anthropic-auth.json'),
        join(timeoutProbePool, 'anthropic-auth-state.json'),
      )
      const store = createNativePoolStore({ paths, quota })
      const read = await store.read()
      if (read.status !== 'ready' || !read.rows[0])
        throw new Error('Prepared probe row required')
      const binding = captureNativeLocalPoolBinding(paths, read.rows[0])
      let proof: NativeLocalCredentialValidation | undefined
      const coordinator = createNativeRefreshCoordinator({
        paths,
        quota,
        readRestrictions: async (subject) => policyFor(subject),
        readAdmission: async () =>
          proof
            ? { status: 'proven', validation: proof }
            : { status: 'unproven' },
        reconcile: async (event) => {
          record(`reconcile:${event.status}`)
          if (
            event.status === 'persisted' &&
            event.identity &&
            event.bootstrap === 'resolved'
          ) {
            const current = await store.read()
            const row = current.status === 'ready' ? current.rows[0] : undefined
            if (!row) throw new Error('Persisted row required')
            proof = proofFor({ ...binding, identity: event.identity }, row)
          }
        },
        resolveIdentity: identity,
        refreshToken: async () => {
          record('provider:entered')
          entered.release()
          await release.promise
          record('provider:returned')
          return provider({ refreshToken: 'synthetic' })
        },
      })
      job = coordinator.authorize({ mode: 'local', binding, intent: 'refresh' })
      await entered.promise
    })
    test('runner timeout probe deadline', async () => {
      const timer = setTimeout(release.release, 200)
      try {
        const result = await job
        record('body:returned', { status: result.status })
      } finally {
        timeoutProbeFinallySeen = true
        record('body:finally')
        clearTimeout(timer)
      }
    }, 50)
    test('runner timeout probe observer', async () => {
      const result = await job
      record('observer:returned', { status: result.status })
      expect(result.status).toBe('usable')
      const successor = await fixture()
      await successor.add('successor', 'A')
      const next = await successor.coordinator().refresh({
        mode: 'local',
        binding: await successor.binding('successor'),
      })
      expect(next.status).toBe('usable')
    })
  })
}

test('real Bun timeout preserves active fixture files until the body actually finishes', async () => {
  const parentStarted = Date.now()
  const pool = await fixture()
  await pool.add('probe', 'A')
  const ledger = await fixture()
  const log = join(ledger.root, 'timeout-probe.jsonl')
  await writeFile(log, '', { mode: 0o600 })
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      import.meta.file,
      '--test-name-pattern',
      'runner timeout probe',
    ],
    {
      env: {
        ...process.env,
        NATIVE_REFRESH_TIMEOUT_POOL: pool.root,
        NATIVE_REFRESH_TIMEOUT_LOG: log,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  )
  let diagnostics: string | undefined
  const retain = (stderr?: string, stdout?: string) => {
    if (!diagnostics) {
      const root = join(
        process.cwd(),
        'node_modules/.cache/native-coordinator-diagnostics',
      )
      mkdirSync(root, { recursive: true })
      diagnostics = mkdtempSync(join(root, 'timeout-'))
      console.error(`BUN-TIMEOUT-DIAGNOSTICS ${diagnostics}`)
    }
    const events = readFileSync(log, 'utf8')
    writeFileSync(join(diagnostics, 'events.jsonl'), events)
    if (stderr !== undefined) writeFileSync(join(diagnostics, 'stderr'), stderr)
    if (stdout !== undefined) writeFileSync(join(diagnostics, 'stdout'), stdout)
    appendFileSync(
      join(diagnostics, 'snapshots.jsonl'),
      `${JSON.stringify({ at: Date.now(), parentStarted, exitCode: child.exitCode, stderr, stdout, events })}\n`,
    )
  }
  // Save the collected cleanup-hook events before the five-second deadline
  // without adding pipe readers. Save child output when its existing readers
  // reach EOF, including partial output when the child is terminated.
  const diagnostic = setTimeout(
    () => retain(),
    Math.max(0, parentStarted + 4_000 - Date.now()),
  )
  const [exit, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  clearTimeout(diagnostic)
  const events = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          event: string
          finallySeen?: boolean
          poolExists?: boolean
          status?: string
        },
    )
  if (
    exit !== 1 ||
    !stderr.includes('1 pass') ||
    !stderr.includes('1 fail') ||
    stderr.includes('Unhandled error') ||
    !events.find((event) => event.event === 'cleanup:1')?.finallySeen ||
    events.find((event) => event.event === 'cleanup:1')?.poolExists !== false
  )
    retain(stderr, stdout)
  expect(exit).toBe(1)
  expect(stderr).toContain('runner timeout probe deadline')
  expect(stderr).toContain('1 pass')
  expect(stderr).toContain('1 fail')
  expect(stderr).not.toContain('Unhandled error')
  expect(events.find((event) => event.event === 'cleanup:1')).toMatchObject({
    finallySeen: true,
    poolExists: false,
  })
  expect(events.find((event) => event.event === 'body:returned')).toMatchObject(
    { status: 'usable' },
  )
  expect(
    events.findIndex((event) => event.event === 'body:finally'),
  ).toBeLessThan(events.findIndex((event) => event.event === 'cleanup:1'))
})

test('lifetime waits for body reads and detached published-store writes and opens late gates', async () => {
  const scenario = new TestLifetime()
  const entered = barrier()
  let finalRead = false
  let lateGateOpened = false
  let store: ReturnType<typeof createNativePoolStore> | undefined
  let detached:
    | ReturnType<ReturnType<typeof createNativePoolStore>['add']>
    | undefined
  const body = testLifetime.run(scenario, () =>
    scenario.runBody(async () => {
      const f = await fixture({
        onStep: async (step) => {
          if (step !== 'before-state-write') return
          const parked = barrier()
          entered.release()
          await parked.promise
          const late = barrier()
          await late.promise
          lateGateOpened = true
        },
      })
      store = createNativePoolStore({ paths: f.paths, quota })
      detached = f.store.add({
        id: 'detached',
        identity: 'A',
        credential: credential('detached'),
      })
      const bodyGate = barrier()
      await bodyGate.promise
      await f.store.read()
      finalRead = true
    }),
  )
  try {
    await entered.promise
    await scenario.finish()
    await body
    await detached
    expect(finalRead).toBe(true)
    expect(lateGateOpened).toBe(true)
    expect(await store?.read()).toMatchObject({
      status: 'ready',
      rows: [expect.objectContaining({ id: 'detached', stamp: 'bound' })],
    })
  } finally {
    await scenario.finish()
    await Promise.all(
      [...(scenarioRoots.get(scenario) ?? [])].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    )
  }
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
      trackLock(active, e)
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
  await f.seedProof('a')
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
  await f.seedProof('a')
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

test('same-token invalid grant restriction cannot be cleared by adoption', async () => {
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
  expect(f.observations.map((e) => e.status)).toEqual(['refused'])
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
  expect(result.failure).toMatchObject({
    kind: 'after-persist-hook',
  })
  expect(JSON.stringify(result)).not.toContain('access-new')
  expect(JSON.stringify(result)).not.toContain('refresh-new')
  expect(f.observations.map((e) => e.status)).toEqual(['persisted', 'failed'])
  const failed = f.observations.find((event) => event.status === 'failed')
  expect(failed?.committed?.version.accessFingerprint).toBe(
    tokenFingerprint('access-new'),
  )
  expect(failed?.credentialVersion?.accessFingerprint).toBe(
    tokenFingerprint('access-a'),
  )
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
  ).toMatchObject({ status: 'usable', source: 'validated' })
  const spec = nativeAccountProviderLock(f.paths, 'A')
  await withLock(
    spec.path,
    { ...POOL_LOCK_DEFAULTS, name: spec.name },
    async (lock) => {
      await lock.assertOwned()
    },
  )
})

// The child owns rejection detection, outside Bun's test-runner handlers. The
// wrapper observes completion of the real acquisition attempt independently of
// onContended, so omitting the event fails an assertion while finally still
// releases the holder and awaits the refresh body.
const physicalHandoffProbe = `
  import assert from 'node:assert/strict';
  import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
  import { setImmediate } from 'node:timers/promises';
  import { mock } from 'bun:test';
  import * as physical from '@cortexkit/common-auth/fs';
  import { fingerprintOf } from '@cortexkit/common-auth/store';
  const { root, mode } = JSON.parse(process.env.NATIVE_PHYSICAL_HANDOFF_PROBE);
  const unhandled = [];
  process.on('unhandledRejection', (error) => {
    unhandled.push(String(error));
    console.error('ESCAPED HANDOFF DIAGNOSTIC REJECTION', error);
    process.exitCode = 1;
  });
  const attempts = [];
  let spec;
  let attempted;
  const firstAttempt = new Promise((resolve) => { attempted = resolve; });
  const acquire = physical.acquireRefreshFileLock;
  mock.module('@cortexkit/common-auth/fs', () => ({
    ...physical,
    acquireRefreshFileLock: async (options) => {
      if (options.name !== spec?.name) return acquire(options);
      const attempt = { callback: options.onContended };
      attempts.push(attempt);
      try {
        const lock = await acquire(options);
        attempt.result = lock === null ? 'refused' : 'acquired';
        return lock;
      } catch (error) {
        attempt.result = 'exception';
        throw error;
      } finally {
        attempted();
      }
    },
  }));
  const { resolveNativePoolPaths } = await import('./packages/core/src/pool-paths.ts');
  const { createNativePoolStore } = await import('./packages/core/src/pool-store.ts');
  const { captureNativeLocalPoolBinding } = await import('./packages/core/src/pool-binding.ts');
  const { createNativeRefreshCoordinator, nativeAccountProviderLock } = await import('./packages/core/src/native-refresh-coordinator.ts');
  const { tokenFingerprint } = await import('./packages/core/src/token-fingerprint.ts');
  const paths = await resolveNativePoolPaths(root + '/account.json', root + '/state.json');
  const quota = { validate: () => true, merge: (_, value) => value };
  const store = createNativePoolStore({ paths, quota });
  await store.initialize();
  await store.add({ id: 'a', credential: { type: 'oauth', access: 'old', refresh: 'old-refresh', expires: 4000000000000 } });
  const read = await store.read();
  assert.equal(read.status, 'ready');
  const binding = captureNativeLocalPoolBinding(paths, read.rows[0]);
  spec = nativeAccountProviderLock(paths, 'A');
  const lockPath = physical.lockPathFor(spec.path, spec.name);
  const markerPath = lockPath + '.evicting';
  const nonLive = mode === 'non-live' || mode === 'exception';
  let holder;
  if (nonLive) {
    await writeFile(lockPath, JSON.stringify({ ownerId: 'expired-owner', expiresAt: 0 }));
    if (mode === 'non-live') {
      await mkdir(markerPath);
      await writeFile(markerPath + '/owner.json', JSON.stringify({ ownerId: 'marker-holder', createdAt: Date.now() }));
    }
  } else {
    holder = await acquire({ ...spec, renew: true });
    assert.ok(holder);
    await holder.assertOwned();
  }
  const events = [];
  const active = new Set(holder ? [spec.name] : []);
  let bootstraps = 0;
  let providers = 0;
  let staleObserved = 0;
  let persisted;
  let proof;
  const coordinator = createNativeRefreshCoordinator({
    paths, quota,
    ...(mode === 'absent' ? {} : { onLockEvent: (event) => {
      if (event.name !== spec.name) return;
      events.push(event);
      if (event.type === 'acquired') active.add(event.name);
      else if (event.type === 'released') active.delete(event.name);
      if (mode === 'throw') throw new Error('diagnostic throw');
      if (mode === 'reject') return Promise.reject(new Error('diagnostic rejection'));
      if (mode === 'thenable') return { then: (_, reject) => reject(new Error('diagnostic thenable rejection')) };
      if (mode === 'never') return new Promise(() => {});
    } }),
    onLockStep: (lock, step) => {
      if (lock.name === spec.name && step === 'stale-lock-observed') {
        staleObserved++;
        if (mode === 'exception') throw new Error('handoff acquisition barrier failed');
      }
    },
    refreshToken: async (input) => {
      assert.equal(input.maxRetries, 0);
      providers++;
      return { type: 'oauth', access: 'new', refresh: 'new-refresh', expires: 4000000000000, expiresIn: 3600 };
    },
    resolveIdentity: async () => {
      bootstraps++;
      return { deviceId: 'd', sessionId: 's', accountUuid: 'A' };
    },
    readRestrictions: async (subject) => ({
      restriction: { status: 'allowed' },
      context: { subject, runtimeBinding: subject.binding, refreshErrorClearedAt: null, quotaErrorClearedAt: null, quotaErrorGeneration: null },
    }),
    reconcile: async (event) => {
      if (event.status !== 'persisted') return;
      persisted = event;
      const current = await store.read();
      assert.equal(current.status, 'ready');
      const row = current.rows[0];
      proof = { binding: captureNativeLocalPoolBinding(paths, row), credentialFingerprint: row.fingerprint, version: event.committed.version };
    },
    readAdmission: async () => proof ? { status: 'proven', validation: proof } : { status: 'unproven' },
  });
  const operation = coordinator.authorize({ mode: 'local', intent: 'refresh', binding });
  try {
    await Promise.race([firstAttempt, operation.then(() => { throw new Error('Refresh ended before the physical attempt'); })]);
    assert.equal(attempts[0].result, mode === 'exception' ? 'exception' : 'refused');
    if (mode === 'absent') assert.equal(attempts[0].callback, undefined);
    if (nonLive || mode === 'absent') assert.deepEqual(events, []);
    else {
      assert.deepEqual(events, [{ type: 'contended', name: spec.name, path: spec.path }]);
      assert.equal(typeof attempts[0].callback, 'function');
      assert.equal(active.has(spec.name), true);
      await holder.assertOwned();
    }
    if (nonLive) assert.equal(staleObserved, 1);
    await holder?.release();
    holder = undefined;
    if (mode === 'non-live') await rm(markerPath, { recursive: true });
    const result = await operation;
    assert.equal(result.status, 'usable');
    assert.equal(result.access, 'new');
    assert.equal(bootstraps, 1);
    assert.equal(providers, 1);
    assert.equal(persisted.handoff, mode === 'exception' ? 'skipped-loss' : 'acquired');
    assert.equal(persisted.bootstrap, 'resolved');
    assert.equal(persisted.identity, 'A');
    assert.equal(persisted.committed.version.accessFingerprint, tokenFingerprint('new'));
    const loaded = await store.read();
    assert.equal(loaded.status, 'ready');
    assert.equal(loaded.rows[0].credential.access, 'new');
    assert.equal(loaded.rows[0].credential.refresh, 'new-refresh');
    assert.equal(loaded.rows[0].identity, 'A');
    assert.equal(loaded.rows[0].fingerprint, fingerprintOf(loaded.rows[0].credential));
    assert.equal(proof.credentialFingerprint, loaded.rows[0].fingerprint);
    if (mode === 'absent') {
      assert.ok(attempts.length >= 2);
      assert.ok(attempts.every((attempt) => attempt.callback === undefined));
      assert.deepEqual(events, []);
    } else if (mode === 'exception') assert.deepEqual(events, []);
    else {
      const contention = events.slice(0, -2);
      if (nonLive) assert.deepEqual(contention, []);
      else {
        assert.ok(contention.length > 0);
        for (const event of contention) assert.deepEqual(event, { type: 'contended', name: spec.name, path: spec.path });
      }
      assert.deepEqual(events.slice(-2), [
        { type: 'acquired', name: spec.name, path: spec.path },
        { type: 'released', name: spec.name, path: spec.path },
      ]);
      assert.equal(active.size, 0);
    }
    assert.equal((await coordinator.authorize({ mode: 'local', intent: 'serve', binding: proof.binding })).status, 'usable');
    assert.equal(providers, 1);
    assert.equal(bootstraps, 1);
    assert.equal(JSON.parse(await readFile(paths.state, 'utf8')).accounts.a.refresh, 'new-refresh');
  } finally {
    await holder?.release();
    if (mode === 'non-live') await rm(markerPath, { recursive: true, force: true });
    await Promise.allSettled([operation]);
  }
  await setImmediate();
  await setImmediate();
  assert.deepEqual(unhandled, []);
  console.log('physical handoff probe passed: ' + mode);
`

function tracePhysicalChild(
  event: string,
  root: string,
  details: Record<string, unknown> = {},
) {
  const log = process.env.NATIVE_PHYSICAL_CHILD_LIFETIME_LOG
  if (log) {
    appendFileSync(
      log,
      `${JSON.stringify({ event, root, fixtureExists: existsSync(root), ...details })}\n`,
    )
  }
}

async function physicalHandoffChild(
  root: string,
  workspace: string,
  mode: string,
): Promise<
  | { status: 'cancelled' }
  | { status: 'completed'; exit: number | null; stdout: string; stderr: string }
> {
  const lifetime = testLifetime.getStore()
  if (!lifetime) throw new Error('Physical child requires a fixture lifetime')
  let ownedRoots = physicalChildRoots.get(lifetime)
  if (!ownedRoots) {
    ownedRoots = new Set()
    physicalChildRoots.set(lifetime, ownedRoots)
  }
  ownedRoots.add(root)
  // The fixture owns cancellation and reaping rather than relying on Bun's
  // test-runner cleanup of dangling subprocesses.
  const child = spawn(process.execPath, ['--eval', physicalHandoffProbe], {
    cwd: workspace,
    env: {
      ...process.env,
      NATIVE_PHYSICAL_HANDOFF_PROBE: JSON.stringify({ root, mode }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  tracePhysicalChild('child:spawned', root, { pid: child.pid, mode })
  let drained = false
  let cancellationReason: string | undefined
  const cancel = lifetime.gate()
  // Teardown opens this gate before waiting for the body. A stalled child must
  // not keep TestLifetime.finish waiting forever with its fixture files alive.
  const cancellation = cancel.wait.then(() => {
    if (drained) return
    cancellationReason ??= 'fixture teardown'
    tracePhysicalChild('child:cancelled', root, {
      pid: child.pid,
      reason: cancellationReason,
    })
    child.kill('SIGKILL')
  })
  lifetime.trackDetached(cancellation)
  async function drain(
    stream: typeof child.stdout,
    event: 'stdout:drained' | 'stderr:drained',
  ) {
    stream.setEncoding('utf8')
    let output = ''
    let readRejected = false
    try {
      for await (const chunk of stream) output += chunk
      return output
    } catch (error) {
      readRejected = true
      throw error
    } finally {
      tracePhysicalChild(event, root, {
        [event === 'stdout:drained' ? 'stdout' : 'stderr']: output,
        readRejected,
      })
    }
  }
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exit, signal) => {
      tracePhysicalChild('child:exited', root, {
        pid: child.pid,
        exit,
        signal,
      })
      resolve(exit)
    })
  })
  const stdoutRead = drain(child.stdout, 'stdout:drained')
  const stderrRead = drain(child.stderr, 'stderr:drained')
  const completion = [exited, stdoutRead, stderrRead] as const
  let cleanupFailure: unknown
  const result = await (async () => {
    try {
      const [exit, stdout, stderr] = await Promise.all(completion)
      drained = true
      if (cancellationReason) return { status: 'cancelled' as const }
      return { status: 'completed' as const, exit, stdout, stderr }
    } finally {
      try {
        if (!drained) child.kill('SIGKILL')
      } catch (error) {
        cleanupFailure = error
      }
      // Promise.all fails fast on a read error. Join each pipe and the process
      // separately before releasing the cancellation task or deleting fixtures.
      await Promise.allSettled(completion)
      drained = true
      cancel.open()
      try {
        await cancellation
      } catch (error) {
        cleanupFailure ??= error
      }
      tracePhysicalChild('child:fully-drained', root, { pid: child.pid })
    }
  })()
  // Cleanup errors are raised only after a successful body, never in place of
  // the original acquisition or pipe-read error.
  if (cleanupFailure) throw cleanupFailure
  return result
}

for (const [mode, name] of [
  [
    'observe',
    'physical handoff contention forwards exact producer diagnostics and release sequence',
  ],
  ['throw', 'physical handoff contention isolates throwing diagnostics'],
  ['reject', 'physical handoff contention isolates rejected promises'],
  ['thenable', 'physical handoff contention isolates rejected thenables'],
  ['never', 'physical handoff contention ignores never-settling diagnostics'],
  [
    'absent',
    'physical handoff omits the producer callback without an observer',
  ],
  [
    'non-live',
    'physical handoff non-live marker refusal does not fabricate contention',
  ],
  [
    'exception',
    'physical handoff acquisition exception does not fabricate contention',
  ],
] as const) {
  test(name, async () => {
    const f = await fixture()
    const workspace = resolve(import.meta.dir, '../../../..')
    try {
      const result = await physicalHandoffChild(f.root, workspace, mode)
      // Teardown cancellation follows an already reported runner timeout. End
      // the body after joining the child, without producing late assertion errors.
      if (result.status === 'cancelled') return
      const { exit, stdout, stderr } = result
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).toContain(`physical handoff probe passed: ${mode}`)
    } finally {
      tracePhysicalChild('body:finally', f.root)
    }
  })
}

test('throwing handoff diagnostics preserve handoff and identity validation', async () => {
  const events: NativeLockEvent[] = []
  let bootstraps = 0
  const f = await fixture({
    onLockEvent: (e) => {
      if (e.name.startsWith('native-account-provider')) {
        events.push(e)
        throw new LockOwnershipError({ target: e.path, name: e.name })
      }
    },
  })
  await f.add('a')
  expect(
    await f
      .coordinator({
        resolveIdentity: async () => {
          bootstraps++
          return {
            deviceId: 'd',
            sessionId: 's',
            accountUuid: accountUuid('A'),
          }
        },
      })
      .refresh({ mode: 'local', binding: await f.binding('a') }),
  ).toMatchObject({ status: 'usable', access: 'access-new' })
  expect(f.observations).toContainEqual(
    expect.objectContaining({
      status: 'persisted',
      handoff: 'acquired',
      bootstrap: 'resolved',
      identity: 'A',
    }),
  )
  expect(bootstraps).toBe(1)
  const spec = nativeAccountProviderLock(f.paths, 'A')
  expect(events).toEqual([
    { type: 'acquired', name: spec.name, path: spec.path },
    { type: 'released', name: spec.name, path: spec.path },
  ])
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
})

test('diagnostic isolation preserves awaited handoff lock-step barriers', async () => {
  const f = await fixture()
  await f.add('a')
  const spec = nativeAccountProviderLock(f.paths, 'A')
  const entered = barrier()
  const finish = barrier()
  let settled = false
  let released = false
  const c = f.coordinator({
    onLockEvent: (event) => {
      if (event.name === spec.name && event.type === 'released') released = true
      return new Promise<void>(() => {})
    },
    onLockStep: async (lock, step) => {
      if (lock.name === spec.name && step === 'release-owner-confirmed') {
        entered.release()
        await finish.promise
      }
    },
  })
  const operation = c
    .refresh({ mode: 'local', binding: await f.binding('a') })
    .then((result) => {
      settled = true
      return result
    })
  try {
    await entered.promise
    expect(settled).toBe(false)
    expect(released).toBe(false)
  } finally {
    finish.release()
    await operation
  }
  expect(await operation).toMatchObject({
    status: 'usable',
    access: 'access-new',
  })
  expect(released).toBe(true)
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
      trackLock(active, e)
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
    const handoffEvents: NativeLockEvent[] = []
    try {
      const result = await f
        .coordinator({
          onLockEvent: (event) => {
            if (event.name === spec.name) handoffEvents.push(event)
          },
        })
        .refresh({ mode: 'local', binding: await f.binding('a') })
      expect(result).toMatchObject({ status: 'usable' })
      expect((await f.row('a')).credential).toMatchObject(credential('new'))
      expect(f.observations).toContainEqual(
        expect.objectContaining({
          status: 'persisted',
          handoff: 'skipped-contention',
        }),
      )
      // The held lease generates contended events, but timeout does not generate
      // acquired or released events for the waiter.
      expect(handoffEvents.length).toBeGreaterThan(0)
      expect(
        handoffEvents.every(
          (event) =>
            event.type === 'contended' &&
            event.name === spec.name &&
            event.path === spec.path,
        ),
      ).toBe(true)
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
  ['rate limit', new ClaudeOAuthRefreshError(429, 'busy', '7'), 1, 'transient'],
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
    expect(result.failure).toMatchObject({ kind: 'provider', classification })
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

test('rate limit reconciliation preserves transient retry metadata and blocks a later same-token refresh', async () => {
  let captures = 0
  const f = await fixture({
    hold: () => {
      captures++
    },
  })
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const cause = new ClaudeOAuthRefreshError(429, 'busy', '7')
  let calls = 0
  let restriction: NativeRefreshRestriction = allowed
  const c = f.coordinator({
    refreshToken: async (input) => {
      expect(input.maxRetries).toBe(0)
      calls++
      throw cause
    },
    readRestrictions: async () => restriction,
    reconcile: async (event) => {
      f.observations.push(event)
      if (
        event.status === 'failed' &&
        event.failure.classification === 'transient' &&
        event.credentialFingerprint
      ) {
        restriction = {
          status: 'blocked',
          reason: 'refresh-backoff',
          credentialFingerprint: event.credentialFingerprint,
        }
      }
    },
  })
  const first = await c.refresh({ mode: 'local', binding })
  expect(first).toMatchObject({
    status: 'failed',
    persisted: false,
    reconciliationFailed: false,
  })
  if (first.status !== 'failed') throw new Error('Expected failed result')
  expect(first.failure).toMatchObject({
    kind: 'provider',
    classification: 'transient',
  })
  expect(f.observations).toHaveLength(1)
  expect(f.observations[0]).toMatchObject({
    status: 'failed',
    credentialFingerprint: fingerprintOf(credential('a')),
    failure: {
      kind: 'provider',
      classification: 'transient',
      status: 429,
      retryAfter: 7,
    },
    persisted: false,
  })
  expect(calls).toBe(1)
  expect(captures).toBe(1)
  expect(await c.refresh({ mode: 'local', binding })).toMatchObject({
    status: 'refused',
    reason: 'refresh-backoff',
    persisted: false,
  })
  expect(calls).toBe(1)
  expect(captures).toBe(1)
  expect(f.observations.map((event) => event.status)).toEqual([
    'failed',
    'refused',
  ])
  expect((await f.row('a')).credential).toMatchObject(credential('a'))
})

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
    readAdmission: async (subject) => {
      if (
        restriction.status === 'blocked' &&
        restriction.reason === 'quota-ineligible'
      )
        return { status: 'blocked', reason: 'quota-ineligible' }
      const validation = f.proofs.get(subject.binding.rowId)
      return validation
        ? { status: 'proven', validation }
        : { status: 'unproven' }
    },
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

test('seeded positive proof serves current material without a job or exchange', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const validation = await f.seedProof('a')
  const c = f.coordinator({
    refreshToken: async () => {
      throw new Error('Unexpected exchange')
    },
    resolveIdentity: async () => {
      throw new Error('Unexpected bootstrap')
    },
    readRestrictions: async () => {
      throw new Error('Serving is not exchange eligibility')
    },
  })
  const result = await c.authorize({
    intent: 'serve',
    mode: 'local',
    binding: await f.binding('a'),
  })
  expect(result).toMatchObject({
    status: 'usable',
    source: 'current',
    access: 'access-a',
    subject: validation,
    validation,
  })
  if (result.status !== 'usable') throw new Error('Expected receipt')
  expect(
    nativeLocalCredentialValidationMatches(
      result.validation,
      result.binding,
      (await f.row('a')).credential,
    ),
  ).toBe(true)
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result.subject.version)).toBe(true)
  expect(Object.isFrozen(result.validation.binding)).toBe(true)
  expect(JSON.stringify(result.subject)).not.toContain('access-a')
  expect(f.observations).toEqual([])
  const publicFactory = createNativeRefreshCoordinator({
    paths: f.paths,
    quota,
    readRestrictions: async (subject) => policyFor(subject),
    readAdmission: async () => ({ status: 'proven', validation }),
    reconcile: async () => {},
  })
  expect(Object.keys(publicFactory)).toEqual(['authorize'])
})

test('explicit refresh exchanges proven unexpired material but a proven 401 successor adopts', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  await f.seedProof('a')
  let exchanges = 0
  let bootstraps = 0
  const c = f.coordinator({
    refreshToken: async () => {
      exchanges++
      return provider({ refreshToken: 'x' })
    },
    resolveIdentity: async () => {
      bootstraps++
      return identity('x', undefined, undefined)
    },
  })
  const binding = await f.binding('a')
  expect(
    await c.authorize({ intent: 'refresh', mode: 'local', binding }),
  ).toMatchObject({ status: 'usable', source: 'rotated', access: 'access-new' })
  expect(exchanges).toBe(1)
  expect(bootstraps).toBe(1)
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding,
      rejectedAccessToken: 'access-a',
    }),
  ).toMatchObject({ status: 'usable', source: 'adopted' })
  expect(exchanges).toBe(1)
  expect(bootstraps).toBe(1)
})

test('positive admission refuses a forged exact-version echo', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const proof = await f.seedProof('a')
  const forged = {
    ...proof,
    version: { ...proof.version, expires: proof.version.expires + 1 },
  }
  const c = f.coordinator({
    readAdmission: async () => ({ status: 'proven', validation: forged }),
  })
  expect(
    await c.authorize({
      intent: 'serve',
      mode: 'local',
      binding: await f.binding('a'),
    }),
  ).toMatchObject({
    status: 'refused',
    reason: 'proof-mismatch',
    persisted: false,
  })
  expect(f.observations).toEqual([])
})

for (const defect of [
  'missing',
  'malformed',
  'lineage',
  'binding',
  'access',
  'stamp-presence',
  'stamp-value',
] as const) {
  test(`positive admission rejects ${defect} evidence even after successful recovery`, async () => {
    const f = await fixture()
    await f.add('a', 'A')
    const binding = await f.binding('a')
    const c = f.coordinator({
      readAdmission: async () => {
        const proof = f.proofs.get('a')
        if (!proof || defect === 'missing') return { status: 'unproven' }
        const validation =
          defect === 'malformed'
            ? JSON.parse('{"version":{}}')
            : defect === 'lineage'
              ? { ...proof, credentialFingerprint: '0'.repeat(64) }
              : defect === 'binding'
                ? { ...proof, binding: { ...proof.binding, rowId: 'other' } }
                : defect === 'access'
                  ? {
                      ...proof,
                      version: {
                        ...proof.version,
                        accessFingerprint: '0'.repeat(16),
                      },
                    }
                  : defect === 'stamp-value'
                    ? {
                        ...proof,
                        version: {
                          ...proof.version,
                          lastRefreshedAt:
                            (proof.version.lastRefreshedAt ?? 0) + 1,
                        },
                      }
                    : {
                        ...proof,
                        version: {
                          accessFingerprint: proof.version.accessFingerprint,
                          expires: proof.version.expires,
                        },
                      }
        return { status: 'proven', validation }
      },
    })
    expect(
      await c.authorize({ intent: 'refresh', mode: 'local', binding }),
    ).toMatchObject({
      status: 'refused',
      reason: defect === 'missing' ? 'proof-missing' : 'proof-mismatch',
      persisted: true,
    })
    expect((await f.row('a')).credential).toMatchObject(credential('new'))
  })
}

test('changed-access 401 successor stays unservable when validation publication is declined', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  await f.store.rotate('a', credential('advanced'))
  let bootstraps = 0
  const c = f.coordinator({
    publishProof: false,
    refreshToken: async () => {
      throw new Error('Do not exchange advanced material')
    },
    resolveIdentity: async (access) => {
      expect(access).toBe('access-advanced')
      bootstraps++
      return identity(access, undefined, undefined)
    },
  })
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
      rejectedAccessToken: 'access-a',
    }),
  ).toMatchObject({ status: 'refused', reason: 'proof-missing' })
  expect(bootstraps).toBe(1)
  expect(f.observations.map((e) => e.status)).toEqual(['validation-observed'])
  expect(f.proofs.size).toBe(0)
})

test('validation-only success never writes pool identity or dispatch material', async () => {
  const events: string[] = []
  const f = await fixture({
    onStep: (_step, info) => {
      events.push(info.operation)
    },
  })
  await f.add('a', 'A')
  const configBefore = await readFile(f.paths.config, 'utf8')
  const stateBefore = await readFile(f.paths.state, 'utf8')
  events.length = 0
  let bootstraps = 0
  const c = f.coordinator({
    refreshToken: async () => {
      throw new Error('No exchange')
    },
    resolveIdentity: async (access) => {
      expect(access).toBe('access-a')
      bootstraps++
      return identity(access, undefined, undefined)
    },
  })
  const request = {
    intent: 'serve' as const,
    mode: 'local' as const,
    binding: await f.binding('a'),
  }
  expect(await c.authorize(request)).toMatchObject({
    status: 'usable',
    source: 'validated',
    access: 'access-a',
  })
  expect(await c.authorize(request)).toMatchObject({
    status: 'usable',
    source: 'current',
  })
  expect(bootstraps).toBe(1)
  expect(events).not.toContain('recordIdentity')
  expect(events).not.toContain('refresh')
  expect(await readFile(f.paths.config, 'utf8')).toBe(configBefore)
  expect(await readFile(f.paths.state, 'utf8')).toBe(stateBefore)
  expect(f.observations[0]).toMatchObject({
    status: 'validation-observed',
    context: { subject: f.proofs.get('a') },
  })
})

for (const bootstrapResult of [
  'unavailable',
  'transient',
  'mismatch',
] as const) {
  test(`validation-only ${bootstrapResult} cannot prove identity or leak exceptions`, async () => {
    const f = await fixture()
    await f.add('a', 'A')
    const before = await readFile(f.paths.state, 'utf8')
    const c = f.coordinator({
      resolveIdentity: async () => {
        if (bootstrapResult === 'transient')
          throw Object.assign(new Error('access-a refresh-a socket'), {
            code: 'ECONNRESET',
          })
        return {
          deviceId: 'd',
          sessionId: 's',
          ...(bootstrapResult === 'mismatch'
            ? { accountUuid: accountUuid('B') }
            : {}),
        }
      },
    })
    const result = await c.authorize({
      intent: 'serve',
      mode: 'local',
      binding: await f.binding('a'),
    })
    expect(result).toMatchObject(
      bootstrapResult === 'mismatch'
        ? { status: 'refused', reason: 'validation-contradicted' }
        : {
            status: 'failed',
            failure: { kind: 'validation', classification: 'transient' },
            persisted: false,
          },
    )
    expect(f.proofs.size).toBe(0)
    expect(await readFile(f.paths.state, 'utf8')).toBe(before)
    expect(JSON.stringify([result, f.observations])).not.toContain('access-a')
    expect(JSON.stringify([result, f.observations])).not.toContain('refresh-a')
  })
}

test('exact-version validation backoff suppresses bootstrap but not a changed version', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let backoff: NativeRefreshSubject | undefined
  let bootstraps = 0
  const c = f.coordinator({
    readAdmission: async (subject) => {
      const proof = f.proofs.get('a')
      if (proof) return { status: 'proven', validation: proof }
      if (backoff && JSON.stringify(backoff) === JSON.stringify(subject))
        return { status: 'blocked', reason: 'validation-backoff' }
      return { status: 'unproven' }
    },
    resolveIdentity: async () => {
      if (++bootstraps === 1)
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      return identity('x', undefined, undefined)
    },
    reconcile: async (event) => {
      if (event.status === 'failed') backoff = event.context?.subject
    },
  })
  const request = {
    intent: 'serve' as const,
    mode: 'local' as const,
    binding: await f.binding('a'),
  }
  expect(await c.authorize(request)).toMatchObject({
    status: 'failed',
    failure: { kind: 'validation' },
  })
  expect(backoff).toBeDefined()
  expect(await c.authorize(request)).toMatchObject({
    status: 'refused',
    reason: 'validation-backoff',
  })
  expect(bootstraps).toBe(1)
  await f.store.rotate('a', { ...credential('a'), access: 'advanced' })
  expect(await c.authorize(request)).toMatchObject({
    status: 'usable',
    source: 'validated',
    access: 'advanced',
  })
  expect(bootstraps).toBe(2)
})

for (const material of ['unknown', 'expired', 'missing', 'rejected'] as const) {
  test(`serve uses serialized exchange for ${material} material despite missing proof`, async () => {
    let captures = 0
    const f = await fixture({
      hold: () => {
        captures++
      },
    })
    await f.add('a', material === 'unknown' ? undefined : 'A')
    if (material === 'expired')
      await f.store.rotate('a', { ...credential('a'), expires: 1 })
    if (material === 'missing')
      await f.store.rotate('a', {
        type: 'oauth',
        refresh: 'refresh-a',
        expires: credential('a').expires,
      })
    let exchanges = 0
    const c = f.coordinator({
      refreshToken: async () => {
        exchanges++
        return provider({ refreshToken: 'x' })
      },
    })
    expect(
      await c.authorize({
        intent: 'serve',
        mode: 'local',
        binding: await f.binding('a'),
        ...(material === 'rejected' ? { rejectedAccessToken: 'access-a' } : {}),
      }),
    ).toMatchObject({ status: 'usable', source: 'rotated' })
    expect(exchanges).toBe(1)
    expect(captures).toBe(1)
  })
}

for (const change of ['access', 'expiry', 'stamp', 'stamp-absence'] as const) {
  test(`validation-only publication fences same-epoch ${change} change`, async () => {
    const f = await fixture()
    await f.add('a', 'A')
    const initial = await f.row('a')
    const binding = await f.binding('a')
    const entered = barrier()
    const finish = barrier()
    const c = f.coordinator({
      resolveIdentity: async () => {
        entered.release()
        await finish.promise
        return identity('x', undefined, undefined)
      },
    })
    const pending = c.authorize({ intent: 'serve', mode: 'local', binding })
    await entered.promise
    if (change === 'stamp-absence') {
      const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
      delete state.accounts.a.lastRefreshedAt
      await writeFile(f.paths.state, JSON.stringify(state))
    } else {
      await f.store.rotate('a', {
        ...credential('a'),
        ...(change === 'access'
          ? { access: 'advanced' }
          : change === 'expiry'
            ? { expires: credential('a').expires - 1 }
            : {}),
      })
    }
    const advanced = await f.row('a')
    expect(advanced.fingerprint).toBe(initial.fingerprint)
    expect(advanced.credentialEpoch).toBe(binding.credentialEpoch)
    finish.release()
    expect(await pending).toMatchObject({
      status: 'refused',
      reason: 'proof-missing',
    })
    expect(f.proofs.size).toBe(0)
    expect(f.observations.map((e) => e.status)).toEqual(['validation-observed'])
  })
}

for (const echo of ['captured', 'newer'] as const) {
  test(`admission with ${echo} proof never substitutes a newer row after comparison`, async () => {
    const f = await fixture()
    await f.add('a', 'A')
    const proof = await f.seedProof('a')
    const c = f.coordinator({
      readAdmission: async (subject) => {
        expect(subject).toEqual(proof)
        await f.store.rotate('a', { ...credential('a'), access: 'advanced' })
        const newer = await f.seedProof('a')
        return {
          status: 'proven',
          validation: echo === 'captured' ? proof : newer,
        }
      },
    })
    const result = await c.authorize({
      intent: 'serve',
      mode: 'local',
      binding: await f.binding('a'),
    })
    expect(result).toMatchObject(
      echo === 'captured'
        ? { status: 'usable', access: 'access-a', validation: proof }
        : { status: 'refused', reason: 'proof-mismatch' },
    )
    expect((await f.row('a')).credential).toMatchObject({ access: 'advanced' })
  })
}

test('each joined caller admits its own independently proven concurrent exact version', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const entered = barrier()
  const finish = barrier()
  const c = f.coordinator({
    reconcile: async (e) => {
      if (e.status === 'persisted') {
        entered.release()
        await finish.promise
      }
    },
  })
  const binding = await f.binding('a')
  const owner = c.authorize({ intent: 'refresh', mode: 'local', binding })
  await entered.promise
  const joined = f
    .coordinator()
    .authorize({ intent: 'serve', mode: 'local', binding })
  // The provider looked up access-new. Replace row a with access-independent and
  // seed separate validation evidence for that version. The older account lookup
  // must not validate the changed access token just because refresh lineage agrees.
  await unlink(lockPathFor(f.paths.state, 'row-A'))
  const spec = nativeAccountProviderLock(f.paths, 'A')
  await unlink(lockPathFor(spec.path, spec.name))
  await f.store.rotate('a', { ...credential('new'), access: 'independent' })
  const proof = await f.seedProof('a')
  finish.release()
  for (const result of await Promise.all([owner, joined]))
    expect(result).toMatchObject({
      status: 'usable',
      access: 'independent',
      validation: proof,
      subject: proof,
    })
})

test('publication context survives adapter mutation and final admission', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let captured: NativeRefreshContext | undefined
  let reads = 0
  const c = f.coordinator({
    readRestrictions: async (subject) => {
      const policy = policyFor(subject)
      const context = {
        ...policy.context,
        refreshErrorClearedAt: ++reads,
        quotaErrorGeneration: 0,
      }
      if (reads === 2) captured = context
      return { ...policy, context }
    },
    refreshToken: async () => {
      if (!captured) throw new Error('Context must precede provider')
      // Change the policy hook's returned error-reset timestamp and generation.
      // The persisted observation must retain the values read before exchange.
      Object.assign(captured, {
        refreshErrorClearedAt: 999,
        quotaErrorGeneration: null,
      })
      return provider({ refreshToken: 'x' })
    },
  })
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    }),
  ).toMatchObject({ status: 'usable' })
  const context = f.observations.find((e) => e.status === 'persisted')?.context
  expect(context).toMatchObject({
    refreshErrorClearedAt: 2,
    quotaErrorClearedAt: null,
    quotaErrorGeneration: 0,
  })
  expect(context).not.toBe(captured)
  expect(Object.isFrozen(context)).toBe(true)
  expect(Object.isFrozen(context?.subject.binding)).toBe(true)
  expect(Object.isFrozen(context?.subject.version)).toBe(true)
  expect(reads).toBe(2)
})

test('context echo mismatch refuses before provider and cannot publish credential facts', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let calls = 0
  const c = f.coordinator({
    readRestrictions: async (subject) => {
      const policy = policyFor(subject)
      return {
        ...policy,
        context: {
          ...policy.context,
          subject: {
            ...subject,
            version: { ...subject.version, lastRefreshedAt: 0 },
          },
        },
      }
    },
    refreshToken: async () => {
      calls++
      return provider({ refreshToken: 'x' })
    },
  })
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    }),
  ).toMatchObject({ status: 'failed', failure: { kind: 'caller-hook' } })
  expect(calls).toBe(0)
  expect(f.observations[0]?.context).toBeUndefined()
  expect(f.proofs.size).toBe(0)
})

test('overlapping instances and retries retain distinct per-attempt marker contexts', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  await f.add('b', 'B')
  const entered = barrier()
  const finish = barrier()
  let marker = 7
  let aCalls = 0
  const readRestrictions = async (subject: NativeRefreshSubject) => ({
    ...policyFor(subject),
    context: { ...policyFor(subject).context, refreshErrorClearedAt: marker },
  })
  const a = f.coordinator({
    readRestrictions,
    refreshToken: async () => {
      if (++aCalls === 1) {
        entered.release()
        await finish.promise
        throw new ClaudeOAuthRefreshError(503, 'retry')
      }
      return provider({ refreshToken: 'x' })
    },
    reconcile: async (e) => {
      f.observations.push(e)
      if (e.status === 'failed') marker = 11
    },
  })
  const b = f.coordinator({
    readRestrictions,
    resolveIdentity: async () => ({
      deviceId: 'd',
      sessionId: 's',
      accountUuid: accountUuid('B'),
    }),
  })
  const owner = a.authorize({
    intent: 'refresh',
    mode: 'local',
    binding: await f.binding('a'),
  })
  await entered.promise
  marker = 9
  expect(
    await b.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('b'),
    }),
  ).toMatchObject({ status: 'usable' })
  finish.release()
  expect(await owner).toMatchObject({ status: 'usable' })
  expect(
    f.observations.map((e) => [
      e.binding.rowId,
      e.attempt,
      e.context?.refreshErrorClearedAt,
    ]),
  ).toEqual([
    ['b', 1, 9],
    ['a', 1, 7],
    ['a', 2, 11],
  ])
  const subjects = f.observations.map((e) => e.context?.subject.binding.rowId)
  expect(subjects).toEqual(['b', 'a', 'a'])
})

test('physical exchange captures markers after row provider and shared store waits', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const entered = barrier()
  const finish = barrier()
  let marker = 1
  let reads = 0
  const spec = nativeAccountProviderLock(f.paths, 'A')
  const holder = track(
    withLock(
      spec.path,
      { ...POOL_LOCK_DEFAULTS, name: spec.name },
      async () => {
        entered.release()
        await finish.promise
      },
    ),
  )
  await entered.promise
  const preliminary = barrier()
  const c = f.coordinator({
    readRestrictions: async (subject) => {
      if (++reads === 1) preliminary.release()
      return {
        ...policyFor(subject),
        context: {
          ...policyFor(subject).context,
          refreshErrorClearedAt: marker,
        },
      }
    },
    hold: async () => {
      // The store has captured row a's credential under the provider lease and
      // released config/state locks. Change the reset timestamp before the
      // exchange callback reads policy, so it must observe 3 rather than 1.
      marker = 3
    },
  })
  const pending = c.authorize({
    intent: 'refresh',
    mode: 'local',
    binding: await f.binding('a'),
  })
  await preliminary.promise
  marker = 2
  finish.release()
  await holder
  expect(await pending).toMatchObject({ status: 'usable' })
  expect(
    f.observations.find((e) => e.status === 'persisted')?.context
      ?.refreshErrorClearedAt,
  ).toBe(3)
})

test('failed retry recapture cannot reuse the previous attempt context', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let reads = 0
  const c = f.coordinator({
    readRestrictions: async (subject) => {
      if (++reads === 3) throw new Error('capture failed access-a refresh-a')
      return policyFor(subject)
    },
    refreshToken: async () => {
      throw new ClaudeOAuthRefreshError(503, 'retry')
    },
  })
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    }),
  ).toMatchObject({ status: 'failed', failure: { kind: 'caller-hook' } })
  expect(f.observations).toHaveLength(2)
  expect(f.observations[0]?.context).toBeDefined()
  expect(f.observations[1]).toMatchObject({ attempt: 2, status: 'failed' })
  expect(f.observations[1]?.context).toBeUndefined()
})

test('strict refresh stamp prevents overwriting a concurrent repeated dispatch', async () => {
  let time = 1_000
  const f = await fixture({ now: () => time })
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const entered = barrier()
  const finish = barrier()
  const c = f.coordinator({
    resolveIdentity: async () => {
      entered.release()
      await finish.promise
      return identity('x', undefined, undefined)
    },
  })
  const pending = c.authorize({ intent: 'refresh', mode: 'local', binding })
  await entered.promise
  // Rewrite row a's lastRefreshedAt without changing access, refresh or expiry.
  // Keep row/provider leases intact so sameDispatch's timestamp comparison must
  // refuse the overwrite, rather than an earlier lock-ownership check doing so.
  const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
  state.accounts.a.lastRefreshedAt = ++time
  await writeFile(f.paths.state, JSON.stringify(state))
  expect((await f.row('a')).credential).toMatchObject({
    lastRefreshedAt: 1_001,
  })
  finish.release()
  expect(await pending).toMatchObject({
    status: 'refused',
    reason: 'dispatch-changed',
    persisted: false,
  })
  expect((await f.row('a')).credential).toMatchObject({
    access: 'access-a',
    lastRefreshedAt: 1_001,
  })
  expect(f.observations.map((e) => e.status)).toEqual(['refused'])
})

test('failed committed attribution retains actual stored lineage and exact version', async () => {
  let interrupt = false
  const f = await fixture({
    onStep: (step, info) => {
      if (
        interrupt &&
        info.operation === 'refresh' &&
        step === 'before-config-write'
      )
        throw new Error('access-new refresh-new interruption')
    },
  })
  await f.add('a', 'A')
  const binding = await f.binding('a')
  const before = await f.row('a')
  interrupt = true
  const result = await f
    .coordinator({
      resolveIdentity: async () => ({
        deviceId: 'd',
        sessionId: 's',
        accountUuid: accountUuid('B'),
      }),
    })
    .authorize({ intent: 'refresh', mode: 'local', binding })
  expect(result).toMatchObject({ status: 'failed', persisted: true })
  const stored = await f.row('a')
  expect(stored.credential).toMatchObject(credential('new'))
  expect(f.observations).toHaveLength(1)
  const failed = f.observations[0]
  if (failed?.status !== 'failed')
    throw new Error('Failed observation required')
  expect(failed.committed?.credentialFingerprint).toBe(
    fingerprintOf(credential('new')),
  )
  expect(failed.committed?.credentialFingerprint).not.toBe(before.fingerprint)
  expect(dispatchMatches(failed.committed?.version, stored)).toBe(true)
  expect(failed.context?.subject.credentialFingerprint).toBe(before.fingerprint)
  expect(Object.isFrozen(failed.committed)).toBe(true)
  expect(f.proofs.size).toBe(0)
  expect(JSON.stringify([result, failed])).not.toContain('access-new')
  expect(JSON.stringify([result, failed])).not.toContain('refresh-new')
})

test('after-first-write without committed material never guesses a committed subject', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const c = f.coordinator({
    hold: async () => {
      throw new PoolOperationError({
        operation: 'refresh',
        rowId: 'a',
        phase: 'after-first-write',
        retryable: false,
        kind: 'after-persist-hook',
        cause: new Error('secret access-a refresh-a'),
      })
    },
  })
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    }),
  ).toMatchObject({ status: 'failed', persisted: true })
  expect(f.observations).toHaveLength(1)
  const failed = f.observations[0]
  if (failed?.status !== 'failed')
    throw new Error('Failed observation required')
  expect(failed.persisted).toBe(true)
  expect(failed.committed).toBeUndefined()
  expect(f.proofs.size).toBe(0)
})

test('hook exceptions are not upstream authentication failures or public bearer carriers', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  await f.seedProof('a')
  const error = new PoolOperationError({
    operation: 'refresh',
    rowId: 'a',
    phase: 'after-first-write',
    retryable: false,
    kind: 'provider',
    committed: credential('secret'),
    cause: new ClaudeOAuthRefreshError(400, 'invalid_grant access-secret'),
  })
  const result = await f
    .coordinator({
      readAdmission: async () => {
        throw error
      },
    })
    .authorize({
      intent: 'serve',
      mode: 'local',
      binding: await f.binding('a'),
    })
  expect(result).toEqual({
    status: 'failed',
    failure: { kind: 'caller-hook', classification: 'permanent' },
    persisted: false,
    reconciliationFailed: false,
  })
  expect(JSON.stringify(result)).not.toContain('secret')
  const failedValidation = await f
    .coordinator({
      readAdmission: async () => ({ status: 'unproven' }),
      resolveIdentity: async () => {
        throw Object.assign(new Error('access-secret'), { code: 'ECONNRESET' })
      },
      reconcile: async () => {
        throw error
      },
    })
    .authorize({
      intent: 'serve',
      mode: 'local',
      binding: await f.binding('a'),
    })
  expect(failedValidation).toMatchObject({
    status: 'failed',
    failure: { kind: 'validation', classification: 'transient' },
    reconciliationFailed: true,
  })
})

test('a marker clear during validation declines stale proof publication', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let marker: number | null = null
  const entered = barrier()
  const finish = barrier()
  let published = false
  const c = f.coordinator({
    publishProof: false,
    readRestrictions: async (subject) => ({
      ...policyFor(subject),
      context: { ...policyFor(subject).context, refreshErrorClearedAt: marker },
    }),
    resolveIdentity: async () => {
      entered.release()
      await finish.promise
      return identity('x', undefined, undefined)
    },
    reconcile: async (event) => {
      f.observations.push(event)
      if (
        event.status !== 'validation-observed' ||
        event.context?.refreshErrorClearedAt !== marker
      )
        return
      const row = await f.row('a')
      const subject = event.context.subject
      if (
        !nativeLocalPoolBindingMatches(subject.binding, f.paths, row) ||
        row.fingerprint !== subject.credentialFingerprint ||
        !dispatchMatches(subject.version, row)
      )
        return
      await f.seedProof('a')
      published = true
    },
  })
  const pending = c.authorize({
    intent: 'serve',
    mode: 'local',
    binding: await f.binding('a'),
  })
  await entered.promise
  marker = 0
  finish.release()
  expect(await pending).toMatchObject({
    status: 'refused',
    reason: 'proof-missing',
  })
  expect(published).toBe(false)
  expect(f.observations[0]?.context?.refreshErrorClearedAt).toBeNull()
  expect(f.proofs.size).toBe(0)
})

test('exchange recaptures a same-epoch access expiry and stamp change after preliminary policy', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  let reads = 0
  let captured: NativeRefreshSubject | undefined
  const c = f.coordinator({
    readRestrictions: async (subject) => {
      if (++reads === 1)
        await f.store.rotate('a', {
          ...credential('a'),
          access: 'advanced',
          expires: credential('a').expires - 1,
        })
      else captured = subject
      return policyFor(subject)
    },
    refreshToken: async () => {
      const current = await f.row('a')
      expect(captured?.version).toMatchObject({
        accessFingerprint: tokenFingerprint('advanced'),
        expires: credential('a').expires - 1,
      })
      expect(dispatchMatches(captured?.version, current)).toBe(true)
      return provider({ refreshToken: 'x' })
    },
  })
  expect(
    await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    }),
  ).toMatchObject({ status: 'usable' })
  expect(f.observations[0]?.context?.subject).toEqual(captured)
})

test('a failed admission after persistence is sanitized without discarding reconciliation facts', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  const result = await f
    .coordinator({
      readAdmission: async () => {
        throw new Error('access-new refresh-new admission failed')
      },
    })
    .authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    })
  expect(result).toEqual({
    status: 'failed',
    failure: { kind: 'caller-hook', classification: 'permanent' },
    persisted: true,
    reconciliationFailed: false,
  })
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
  expect(f.observations[0]).toMatchObject({
    status: 'persisted',
    committed: { credentialFingerprint: fingerprintOf(credential('new')) },
  })
  expect(JSON.stringify(result)).not.toContain('access-new')
})

test('malformed bootstrap identity cannot discard an already consumed successor', async () => {
  const f = await fixture()
  await f.add('a')
  const result = await f
    .coordinator({
      resolveIdentity: async () => ({
        deviceId: 'd',
        sessionId: 's',
        accountUuid: accountUuid(' '),
      }),
    })
    .authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    })
  expect(result).toMatchObject({
    status: 'refused',
    reason: 'identity-unproven',
    persisted: true,
  })
  expect((await f.row('a')).credential).toMatchObject(credential('new'))
  expect((await f.row('a')).identity).toBeUndefined()
  expect(f.observations[0]).toMatchObject({
    status: 'persisted',
    bootstrap: 'unavailable',
    committed: { credentialFingerprint: fingerprintOf(credential('new')) },
  })
})

test('positive proof does not override closed serving eligibility restrictions', async () => {
  const f = await fixture()
  await f.add('a', 'A')
  await f.seedProof('a')
  const binding = await f.binding('a')
  for (const reason of [
    'quota-ineligible',
    'account-disabled',
    'local-mode-unavailable',
    'refresh-backoff',
    'invalid-grant',
    'validation-backoff',
  ] as const) {
    const result = await f
      .coordinator({
        readAdmission: async () => ({ status: 'blocked', reason }),
        refreshToken: async () => {
          throw new Error('Serving block must not exchange')
        },
      })
      .authorize({ intent: 'serve', mode: 'local', binding })
    expect(result).toEqual({ status: 'refused', reason, persisted: false })
  }
  expect(f.observations).toEqual([])
})

for (const initialStamp of ['absent', 'zero'] as const) {
  const change = initialStamp === 'absent' ? 'absent-to-zero' : 'zero-to-absent'

  test(`context echo rejects ${change} refresh timestamp substitution`, async () => {
    const f = await fixture()
    await f.add('a', 'A')
    const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
    if (initialStamp === 'absent') delete state.accounts.a.lastRefreshedAt
    else state.accounts.a.lastRefreshedAt = 0
    await writeFile(f.paths.state, JSON.stringify(state))
    const before = await f.row('a')
    expect(before.stamp).toBe('bound')
    expect(Object.hasOwn(before.credential ?? {}, 'lastRefreshedAt')).toBe(
      initialStamp === 'zero',
    )
    let calls = 0
    const c = f.coordinator({
      readRestrictions: async (subject) => {
        expect(Object.hasOwn(subject.version, 'lastRefreshedAt')).toBe(
          initialStamp === 'zero',
        )
        const version = { ...subject.version }
        // Echo the same pool row, refresh lineage, access fingerprint and expiry,
        // but replace an absent refresh timestamp with zero or zero with absence.
        if (initialStamp === 'absent') version.lastRefreshedAt = 0
        else delete version.lastRefreshedAt
        const policy = policyFor(subject)
        return {
          ...policy,
          context: { ...policy.context, subject: { ...subject, version } },
        }
      },
      refreshToken: async () => {
        calls++
        return provider({ refreshToken: 'x' })
      },
    })
    const result = await c.authorize({
      intent: 'refresh',
      mode: 'local',
      binding: await f.binding('a'),
    })
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'caller-hook', classification: 'permanent' },
      persisted: false,
    })
    expect(calls).toBe(0)
    expect((await f.row('a')).credential).toEqual(before.credential)
    expect(f.observations).toHaveLength(1)
    expect(f.observations[0]?.context).toBeUndefined()
    expect(f.proofs.size).toBe(0)
  })

  test(`commit comparison rejects ${change} refresh timestamp foreign write`, async () => {
    const f = await fixture()
    await f.add('a', 'A')
    const initialState = JSON.parse(await readFile(f.paths.state, 'utf8'))
    if (initialStamp === 'absent')
      delete initialState.accounts.a.lastRefreshedAt
    else initialState.accounts.a.lastRefreshedAt = 0
    await writeFile(f.paths.state, JSON.stringify(initialState))
    const before = await f.row('a')
    expect(before.stamp).toBe('bound')
    expect(Object.hasOwn(before.credential ?? {}, 'lastRefreshedAt')).toBe(
      initialStamp === 'zero',
    )
    const binding = await f.binding('a')
    const entered = barrier()
    const finish = barrier()
    const c = f.coordinator({
      resolveIdentity: async () => {
        entered.release()
        await finish.promise
        return identity('x', undefined, undefined)
      },
    })
    const pending = c.authorize({ intent: 'refresh', mode: 'local', binding })
    await entered.promise
    // Change only row a's recorded refresh timestamp while the provider's
    // replacement waits for its account lookup. Keep row/provider leases intact
    // so comparing the captured and current credentials decides the refusal.
    const currentState = JSON.parse(await readFile(f.paths.state, 'utf8'))
    if (initialStamp === 'absent') currentState.accounts.a.lastRefreshedAt = 0
    else delete currentState.accounts.a.lastRefreshedAt
    await writeFile(f.paths.state, JSON.stringify(currentState))
    const changed = await f.row('a')
    expect(changed.stamp).toBe('bound')
    expect(changed.fingerprint).toBe(before.fingerprint)
    expect(changed.credentialEpoch).toBe(before.credentialEpoch)
    expect(Object.hasOwn(changed.credential ?? {}, 'lastRefreshedAt')).toBe(
      initialStamp === 'absent',
    )
    finish.release()
    expect(await pending).toMatchObject({
      status: 'refused',
      reason: 'dispatch-changed',
      persisted: false,
    })
    expect((await f.row('a')).credential).toEqual(changed.credential)
    expect(f.observations).toHaveLength(1)
    expect(f.observations[0]).toMatchObject({
      status: 'refused',
      reason: 'dispatch-changed',
      consumed: true,
    })
    expect(f.proofs.size).toBe(0)
  })
}
