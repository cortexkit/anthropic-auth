import {
  afterEach,
  beforeAll,
  test as bunTest,
  describe,
  expect,
} from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync } from 'node:fs'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
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
  createNativeRefreshCoordinator,
  type NativeRefreshCoordinatorOptions,
  type NativeRefreshDispatchVersion,
  type NativeRefreshObservation,
  type NativeRefreshRestriction,
  type NativeRefreshResult,
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
  type NativePoolStoreOptions,
  nativePoolStoreLocks,
} from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'

const roots: string[] = []
class TestLifetime {
  readonly roots = new Set<string>()
  readonly gates = new Set<() => void>()
  readonly calls = new Set<Promise<unknown>>()
  body?: Promise<void>
  closing = false

  track<T>(call: Promise<T>): Promise<T> {
    this.calls.add(call)
    void call.finally(() => this.calls.delete(call)).catch(() => {})
    return call
  }

  async finish() {
    this.closing = true
    for (const release of this.gates) release()
    this.gates.clear()
    await this.body?.catch(() => {})
    while (this.calls.size) await Promise.allSettled([...this.calls])
  }
}

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
      const running = testLifetime.run(scenario, async () => {
        await body()
      })
      scenario.body = running
      return running
    },
    timeout,
  )
}

function track<T>(call: Promise<T>): Promise<T> {
  return testLifetime.getStore()?.track(call) ?? call
}
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
  const scenario = testLifetime.getStore()
  if (scenario?.closing) release()
  else scenario?.gates.add(release)
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
  const scenario = testLifetime.getStore()
  if (scenario) scenario.roots.add(root)
  else roots.push(root)
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
  function coordinator(
    overrides: Partial<NativeRefreshCoordinatorOptions> = {},
  ) {
    const coordinator = createNativeRefreshCoordinator({
      ...options,
      refreshToken: provider,
      resolveIdentity: identity,
      readRestrictions: async () => allowed,
      reconcile: async (event) => {
        observations.push(event)
      },
      ...overrides,
    })
    return {
      refresh: (request: Parameters<typeof coordinator.refresh>[0]) =>
        track(coordinator.refresh(request)),
    }
  }
  return { root, paths, store, row, binding, add, observations, coordinator }
}

afterEach(async () => {
  const scenario = currentLifetime
  const unscopedRoots = roots.splice(0)
  // Bun reports a timeout without cancelling the test body. Open that body's
  // waiting gates, wait for the body and pending store calls, then delete the
  // test's files.
  await scenario?.finish()
  await Promise.all(
    [...unscopedRoots, ...(scenario?.roots ?? [])].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  )
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
      const capturedClearMarkers = { ...clearMarkers }
      let markersCaptured = false
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
        readRestrictions: async () => {
          const native = JSON.parse(await readFile(f.paths.runtime, 'utf8'))
          if (!markersCaptured) {
            capturedClearMarkers.refreshErrorClearedAt =
              native.refreshErrorClearedAt
            capturedClearMarkers.quotaErrorClearedAt =
              native.quotaErrorClearedAt
            markersCaptured = true
          }
          return allowed
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
                capturedClearMarkers.refreshErrorClearedAt &&
              native.quotaErrorClearedAt ===
                capturedClearMarkers.quotaErrorClearedAt
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
      expect(result.status).toBe(terminal === 'persisted' ? 'usable' : 'failed')
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
        capturedMarkers.refreshErrorClearedAt ===
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
          capturedMarkers.refreshErrorClearedAt ===
            currentMarkers.refreshErrorClearedAt &&
          capturedMarkers.quotaErrorClearedAt ===
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
        if (event.type === 'acquired') active.add(event.name)
        else active.delete(event.name)
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
    readRestrictions: async (binding) =>
      binding.rowId === 'b'
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
      appendFileSync(timeoutProbeLog, `${JSON.stringify({ event, ...data })}\n`)
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
      const coordinator = createNativeRefreshCoordinator({
        paths,
        quota,
        readRestrictions: async () => allowed,
        reconcile: async (event) => {
          record(`reconcile:${event.status}`)
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
      job = coordinator.refresh({ mode: 'local', binding })
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
  const [exit, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
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
  if (!events.find((event) => event.event === 'cleanup:1')?.finallySeen)
    console.error(`BUN-TIMEOUT-PROBE ${JSON.stringify(events)}`)
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
  scenario.body = testLifetime.run(scenario, async () => {
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
    store = f.store
    detached = f.store.add({
      id: 'detached',
      identity: 'A',
      credential: credential('detached'),
    })
    const bodyGate = barrier()
    await bodyGate.promise
    await f.store.read()
    finalRead = true
  })
  try {
    await entered.promise
    await scenario.finish()
    await detached
    expect(finalRead).toBe(true)
    expect(lateGateOpened).toBe(true)
    expect(scenario.calls.size).toBe(0)
    expect(await store?.read()).toMatchObject({
      status: 'ready',
      rows: [expect.objectContaining({ id: 'detached', stamp: 'bound' })],
    })
  } finally {
    await scenario.finish()
    await Promise.all(
      [...scenario.roots].map((root) =>
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
  const failed = f.observations.find((event) => event.status === 'failed')
  expect(failed?.committedVersion?.accessFingerprint).toBe(
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
  expect(first.error.cause).toBe(cause)
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
