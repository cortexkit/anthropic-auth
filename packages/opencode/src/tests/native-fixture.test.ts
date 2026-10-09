import { expect } from 'bun:test'
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  type NativeCustodyClient,
  readNativeMigrationJournal,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import {
  createTestLifetimeSuite,
  TestLifetime,
} from '../../../core/src/tests/test-lifetime.ts'
import {
  migrateNativeOpencodeFixture,
  type NativeOpencodeFixtureLifetime,
} from './native-fixture.ts'

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

const mainIdentity = '11111111-1111-4111-8111-111111111111'
const fallbackIdentity = '22222222-2222-4222-8222-222222222222'
const unrelatedProvider = { type: 'api', key: 'synthetic-unrelated-provider' }
const enrollment = { token: 'ab'.repeat(32), token_generation: 1 }

/** A fresh owner-only directory, removed by the test body's lifetime even if the fixture refuses it. */
async function disposableRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oc-native-fixture-'))
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return root
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

/**
 * Replace fetch for this body only, restoring it before the body returns.
 * The test network guard permits loopback; this replacement records every
 * attempted fetch, including loopback.
 */
async function withoutNetwork<T>(
  body: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; requests: string[] }> {
  const saved = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      requests.push(input instanceof Request ? input.url : String(input))
      throw new Error('Native fixture attempted a network request')
    },
    { preconnect: saved.preconnect },
  )
  try {
    const [result] = await Promise.allSettled([body()])
    return { result: result as PromiseSettledResult<T>, requests }
  } finally {
    globalThis.fetch = saved
  }
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason
  return result.value
}

function rejection(result: PromiseSettledResult<unknown>): unknown {
  if (result.status === 'fulfilled')
    throw new Error('Expected the fixture to be refused')
  return result.reason
}

/**
 * Finish a lifetime whose fixture was expected to fail. Teardown must still
 * reject, and with exactly that one failure, so an unexpected setup failure in
 * a positive test can never pass silently.
 */
async function expectTeardownFailure(
  lifetime: TestLifetime,
  reason: unknown,
): Promise<void> {
  const failure = await lifetime.finish().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toHaveLength(1)
  expect((failure as AggregateError).errors[0]).toBe(reason)
}

/** Forwards to the given lifetime and records what the fixture registered. */
function recordingLifetime(target: NativeOpencodeFixtureLifetime) {
  const calls: string[] = []
  const lifetime: NativeOpencodeFixtureLifetime = {
    deferCleanup: (cleanup) => {
      calls.push('deferCleanup')
      target.deferCleanup(cleanup)
    },
    trackDetached: (work) => {
      calls.push('trackDetached')
      target.trackDetached(work)
    },
  }
  return { lifetime, calls }
}

function localLegacyConfig() {
  return {
    version: 1,
    refresh: { enabled: false },
    quota: { enabled: false },
    accounts: [
      {
        id: 'fallback-route',
        type: 'oauth',
        enabled: true,
        access: 'synthetic-local-fallback-access',
        refresh: 'synthetic-local-fallback-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
      {
        id: 'api-route',
        type: 'api',
        apiKey: 'synthetic-api-route-key',
        baseURL: 'https://synthetic.invalid',
      },
    ],
  }
}

function localHostAuth() {
  return {
    anthropic: {
      type: 'oauth',
      access: 'synthetic-local-main-access',
      refresh: 'synthetic-local-main-refresh',
      expires: Date.now() + 8 * 60 * 60_000,
    },
    other: unrelatedProvider,
  }
}

function vaultLegacyConfig() {
  return {
    version: 1,
    mainAccountId: 'primary-route',
    refresh: { enabled: false },
    quota: { enabled: false },
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: mainIdentity,
        state: 'active',
      },
    },
    accounts: [
      {
        id: 'fallback-route',
        type: 'oauth',
        enabled: true,
        refresh: '',
        claustrumScopedCredentialId: 'oauth:secondary',
        anthropicAccountUuid: fallbackIdentity,
      },
    ],
  }
}

/** Lists two synthetic vault rows and records every call; reading credential material is a failure. */
function syntheticVault() {
  const calls = {
    connect: 0,
    listTokens: [] as Array<string | undefined>,
    getScoped: 0,
    reports: 0,
    close: 0,
  }
  const row = (id: string, accountId: string) => ({
    id,
    accountId,
    credentialType: 'oauth',
    state: 'active',
    categories: ['anthropic-native'],
    serves: ['anthropic'],
    providerIds: [],
    refreshAdapter: 'anthropic',
    recordVersion: 1,
    operations: ['read', 'invalidate'],
    createdAtMs: 1,
  })
  const client: NativeCustodyClient = {
    async listScoped(token) {
      calls.listTokens.push(token)
      return {
        view: 'synthetic-native-view',
        rows: [
          row('oauth:anthropic', mainIdentity),
          row('oauth:secondary', fallbackIdentity),
        ],
      }
    },
    async getScoped() {
      calls.getScoped++
      throw new Error('Discovery must not read vault credential material')
    },
    async reportAuthFailureScoped() {
      calls.reports++
      throw new Error('Discovery must not report credential failures')
    },
    close() {
      calls.close++
    },
  }
  return {
    calls,
    connect: async () => {
      calls.connect++
      return client
    },
  }
}

async function readAccounts(
  paths: Awaited<ReturnType<typeof resolveNativePoolPaths>>,
) {
  const runtime = createNativeAccountRuntime({ paths, host: 'opencode' })
  try {
    return await runtime.read()
  } finally {
    runtime.close()
  }
}

test('local legacy accounts commit through the real migration and keep unrelated host providers', async () => {
  const root = await disposableRoot()
  const { lifetime, calls } = recordingLifetime(lifetimes)
  const { result, requests } = await withoutNetwork(() =>
    migrateNativeOpencodeFixture({
      root,
      lifetime,
      legacyConfig: localLegacyConfig(),
      hostAuth: localHostAuth(),
    }),
  )
  const fixture = fulfilled(result)
  expect(requests).toEqual([])
  expect(calls).toEqual(['trackDetached', 'deferCleanup'])

  expect(fixture.journal).toMatchObject({ phase: 'retired', version: 3 })
  expect(await readNativeMigrationJournal(fixture.paths)).toEqual(
    fixture.journal,
  )
  // Every pool path is the canonical one the production resolver derives
  // from the returned env, and lives in this test's own root.
  expect(fixture.paths).toEqual(
    await resolveNativePoolPaths(
      fixture.env.OPENCODE_ANTHROPIC_AUTH_FILE,
      fixture.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
    ),
  )
  for (const path of [
    ...Object.entries(fixture.paths)
      .filter(([key]) => key !== 'storageId')
      .map(([, value]) => value),
    fixture.hostAuthPath,
    fixture.routingSourcePath,
    fixture.routingDestinationPath,
    fixture.enrollmentPath,
    ...Object.values(fixture.env),
  ])
    expect(path.startsWith(`${fixture.root}/`)).toBe(true)

  const snapshot = await readAccounts(fixture.paths)
  expect(snapshot.mode).toBe('local')
  expect(
    snapshot.accounts.map(({ id, type, source, enabled }) => ({
      id,
      type,
      source,
      enabled,
    })),
  ).toEqual([
    { id: 'main', type: 'oauth', source: 'local', enabled: true },
    { id: 'fallback-route', type: 'oauth', source: 'local', enabled: true },
    { id: 'api-route', type: 'api', source: 'local', enabled: true },
  ])
  // The OAuth credentials from host-auth.json move into pool state beside
  // the existing fallback OAuth credentials and API-route key.
  const poolState = await readFile(fixture.paths.state, 'utf8')
  for (const secret of [
    'synthetic-local-main-access',
    'synthetic-local-fallback-access',
    'synthetic-api-route-key',
  ])
    expect(poolState).toContain(secret)

  const hostAuth = await readFile(fixture.hostAuthPath, 'utf8')
  expect(JSON.parse(hostAuth).other).toEqual(unrelatedProvider)
  expect(hostAuth).not.toContain('synthetic-local-main-access')
  expect(hostAuth).not.toContain('synthetic-local-main-refresh')
  // Without a custody input, the fixture creates no enrollment token and
  // no connection file that could reach the real vault daemon.
  expect(await exists(fixture.enrollmentPath)).toBe(false)
  expect(
    await exists(fixture.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE),
  ).toBe(false)
  expect(await exists(fixture.paths.roster)).toBe(false)
})

test('vault custody discovery publishes the roster and runtime seed through the real publishers', async () => {
  const root = await disposableRoot()
  const vault = syntheticVault()
  const { result, requests } = await withoutNetwork(() =>
    migrateNativeOpencodeFixture({
      root,
      lifetime: lifetimes,
      legacyConfig: vaultLegacyConfig(),
      legacyState: {
        version: 1,
        accounts: {
          'fallback-route': {
            claustrumScopedCredentialId: 'oauth:secondary',
            anthropicAccountUuid: fallbackIdentity,
            lastUsed: 100,
          },
        },
      },
      hostAuth: {
        anthropic: custodyTombstoneOAuth('anthropic'),
        other: unrelatedProvider,
      },
      custody: { connect: vault.connect, enrollment },
    }),
  )
  const fixture = fulfilled(result)
  expect(requests).toEqual([])
  expect(fixture.journal.phase).toBe('retired')

  // The real token reader found the enrollment at the fixture's own path.
  expect(vault.calls).toMatchObject({
    connect: 1,
    listTokens: [enrollment.token],
    getScoped: 0,
    reports: 0,
  })
  expect(vault.calls.close).toBeGreaterThan(0)

  const snapshot = await readAccounts(fixture.paths)
  expect(snapshot.mode).toBe('claustrum')
  const fallback = snapshot.accounts.find(
    (account) => account.id === 'fallback-route',
  )
  expect(fallback).toMatchObject({
    source: 'vault',
    credentialId: 'oauth:secondary',
    accountIdentity: fallbackIdentity,
    lastUsed: 100,
  })
  for (const path of [fixture.paths.roster, fixture.paths.runtime]) {
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(enrollment.token)
  }
  expect(
    JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).other,
  ).toEqual(unrelatedProvider)
})

test('malformed legacy config fails closed before anything is published', async () => {
  const root = await disposableRoot()
  const hostAuth = JSON.stringify(localHostAuth())
  const inner = new TestLifetime()
  const { result, requests } = await withoutNetwork(() =>
    migrateNativeOpencodeFixture({
      root,
      lifetime: inner,
      legacyConfig: '{"version":1,"accounts":[',
      hostAuth,
    }),
  )
  expect(requests).toEqual([])
  expect(result).toMatchObject({
    status: 'rejected',
    reason: { name: 'NativeMigrationError' },
  })
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  expect(await readNativeMigrationJournal(paths)).toBeUndefined()
  for (const path of [paths.config, paths.state, paths.runtime, paths.roster])
    expect(await exists(path)).toBe(false)
  expect(await readFile(join(root, 'host-auth.json'), 'utf8')).toBe(hostAuth)
  await expectTeardownFailure(inner, rejection(result))
  expect(await exists(root)).toBe(false)
})

test('vault config without caller-supplied custody is refused, not guessed', async () => {
  const root = await disposableRoot()
  const inner = new TestLifetime()
  const { result, requests } = await withoutNetwork(() =>
    migrateNativeOpencodeFixture({
      root,
      lifetime: inner,
      legacyConfig: vaultLegacyConfig(),
      hostAuth: {
        anthropic: custodyTombstoneOAuth('anthropic'),
        other: unrelatedProvider,
      },
    }),
  )
  expect(requests).toEqual([])
  expect(result).toMatchObject({
    status: 'rejected',
    reason: { name: 'NativeMigrationError', code: 'invalid-source' },
  })
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  expect(await readNativeMigrationJournal(paths)).toBeUndefined()
  expect(await exists(paths.roster)).toBe(false)
  expect(await exists(join(root, 'opencode-enrollment.json'))).toBe(false)
  await expectTeardownFailure(inner, rejection(result))
})

test('unsafe or non-empty roots are refused and left untouched', async () => {
  const occupied = await disposableRoot()
  const existing = join(occupied, 'anthropic-auth.json')
  await writeFile(existing, 'caller-owned-bytes', { mode: 0o600 })
  const shared = await disposableRoot()
  await chmod(shared, 0o750)
  const target = await disposableRoot()
  const linkParent = await disposableRoot()
  const link = join(linkParent, 'link')
  await symlink(target, link)

  const cases: Array<[string, RegExp]> = [
    [occupied, /not empty/],
    [shared, /not owner-only/],
    [link, /symbolic link/],
    ['relative/root', /not an absolute path/],
    [join(target, 'missing'), /does not exist/],
  ]
  for (const [root, reason] of cases) {
    const inner = new TestLifetime()
    const { lifetime, calls } = recordingLifetime(inner)
    const [result] = await Promise.allSettled([
      migrateNativeOpencodeFixture({
        root,
        lifetime,
        legacyConfig: localLegacyConfig(),
      }),
    ])
    expect(String(rejection(result))).toMatch(reason)
    // A refused root is never claimed, so its removal is never scheduled.
    expect(calls).toEqual(['trackDetached'])
    await expectTeardownFailure(inner, rejection(result))
  }
  expect(await readFile(existing, 'utf8')).toBe('caller-owned-bytes')
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await exists(join(target, 'anthropic-auth.json'))).toBe(false)
})

test('root removal waits for the whole body and its late tracked work', async () => {
  const root = await disposableRoot()
  const inner = new TestLifetime()
  const gate = inner.gate()
  const observed: string[] = []
  const fixture = await inner.runBody(async () => {
    const created = await migrateNativeOpencodeFixture({
      root,
      lifetime: inner,
      legacyConfig: localLegacyConfig(),
    })
    // Late work that outlives the body must still see the fixture files.
    inner.trackDetached(
      (async () => {
        await gate.wait
        observed.push(
          (await exists(created.paths.journal)) ? 'present' : 'removed',
        )
      })(),
    )
    return created
  })
  expect(await exists(fixture.paths.journal)).toBe(true)
  await inner.finish()
  expect(observed).toEqual(['present'])
  expect(await exists(fixture.root)).toBe(false)
})

test('an unawaited fixture call is drained before its root is removed', async () => {
  const root = await disposableRoot()
  const inner = new TestLifetime()
  let pending: ReturnType<typeof migrateNativeOpencodeFixture> | undefined
  await inner.runBody(() => {
    pending = migrateNativeOpencodeFixture({
      root,
      lifetime: inner,
      legacyConfig: localLegacyConfig(),
    })
  })
  if (!pending) throw new Error('Fixture call did not start')
  await inner.finish()
  // The migration finished before teardown removed the directory under it.
  expect((await pending).journal.phase).toBe('retired')
  expect(await exists(root)).toBe(false)
})

test('a forgotten await on a failing fixture fails teardown after its cleanup', async () => {
  // A migration that fails after the root was claimed, and a root refused
  // before anything was claimed. Neither call is awaited by its body.
  const claimed = await disposableRoot()
  const cases = [
    { root: claimed, legacyConfig: '{"version":1,"accounts":[' },
    { root: 'not-an-absolute-path', legacyConfig: localLegacyConfig() },
  ]
  const reasons: unknown[] = []
  for (const { root, legacyConfig } of cases) {
    const inner = new TestLifetime()
    const { result, requests } = await withoutNetwork(async () => {
      let pending: ReturnType<typeof migrateNativeOpencodeFixture> | undefined
      await inner.runBody(() => {
        pending = migrateNativeOpencodeFixture({
          root,
          lifetime: inner,
          legacyConfig,
        })
      })
      if (!pending) throw new Error('Fixture call did not start')
      // Teardown, not the body, is the first to wait for the fixture.
      const teardown = await inner.finish().then(
        () => undefined,
        (error: unknown) => error,
      )
      const [outcome] = await Promise.allSettled([pending])
      return { teardown, reason: rejection(outcome) }
    })
    expect(requests).toEqual([])
    const { teardown, reason } = fulfilled(result)
    expect(teardown).toBeInstanceOf(AggregateError)
    expect((teardown as AggregateError).errors).toHaveLength(1)
    expect((teardown as AggregateError).errors[0]).toBe(reason)
    reasons.push(reason)
  }
  expect(reasons[0]).toMatchObject({ name: 'NativeMigrationError' })
  expect(String(reasons[1])).toMatch(/not an absolute path/)
  // The claimed root's cleanup still ran before teardown reported the failure.
  expect(await exists(claimed)).toBe(false)
})

test('a closed lifetime refuses the fixture before any file is touched', async () => {
  const root = await disposableRoot()
  const inner = new TestLifetime()
  await inner.finish()
  const { result, requests } = await withoutNetwork(async () =>
    migrateNativeOpencodeFixture({
      root,
      lifetime: inner,
      legacyConfig: localLegacyConfig(),
      hostAuth: localHostAuth(),
    }),
  )
  expect(requests).toEqual([])
  expect(String(rejection(result))).toContain('Test fixture lifetime is closed')
  expect(await readdir(root)).toEqual([])
})
