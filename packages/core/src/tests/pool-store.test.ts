import { afterEach, expect, test } from 'bun:test'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveNativePoolPaths } from '../pool-paths.ts'
import {
  createNativePoolStore,
  type NativePoolStoreOptions,
  nativePoolStoreLocks,
} from '../pool-store.ts'

const roots: string[] = []
const quota = {
  validate: (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value),
  merge: (_stored: unknown, observation: unknown) => observation,
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-native-pool-')),
  )
  roots.push(root)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  return { root, paths, store: createNativePoolStore({ paths, quota }) }
}

function credential(suffix: string) {
  return {
    type: 'oauth' as const,
    access: `access-${suffix}`,
    refresh: `refresh-${suffix}`,
    expires: 4_000_000_000_000,
  }
}

async function requiredRow(store: ReturnType<typeof createNativePoolStore>) {
  const loaded = await store.read()
  if (loaded.status !== 'ready' || loaded.rows.length !== 1)
    throw new Error('Expected one ready fixture row')
  const row = loaded.rows[0]
  if (!row) throw new Error('Expected a fixture row')
  return row
}

async function bytes(
  paths: Awaited<ReturnType<typeof resolveNativePoolPaths>>,
) {
  return Promise.all([
    readFile(paths.config, 'utf8'),
    readFile(paths.state, 'utf8'),
  ])
}

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('opens only the new namespace and never falls back to legacy credentials', async () => {
  const { paths, store } = await fixture()
  const legacyConfig =
    '{"version":1,"accounts":[{"id":"legacy","type":"oauth"}]}'
  const legacyState =
    '{"version":1,"accounts":{"legacy":{"access":"legacy-access","refresh":"legacy-refresh","expires":4000000000000}}}'
  await writeFile(paths.legacyConfig, legacyConfig)
  await writeFile(paths.legacyState, legacyState)
  expect(await store.read()).toMatchObject({ status: 'ready', rows: [] })
  await expect(stat(paths.config)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(paths.state)).rejects.toMatchObject({ code: 'ENOENT' })
  await store.initialize()
  expect(await store.read()).toMatchObject({ status: 'ready', rows: [] })
  expect(await readFile(paths.legacyConfig, 'utf8')).toBe(legacyConfig)
  expect(await readFile(paths.legacyState, 'utf8')).toBe(legacyState)
})

test('uses explicit shared locks and writes new credentials only through the stamped store', async () => {
  const { paths, store } = await fixture()
  expect(nativePoolStoreLocks(paths)).toEqual([
    { path: paths.config, name: 'pool-config' },
    { path: paths.state, name: 'pool-state' },
  ])
  await store.initialize()
  await store.add({
    id: 'a',
    identity: 'account-a',
    credential: credential('a'),
  })
  expect(await requiredRow(store)).toMatchObject({
    candidate: true,
    stamp: 'bound',
    credentialEpoch: 1,
    identity: 'account-a',
  })
  const [config, state] = await bytes(paths)
  expect(config).not.toContain('access-a')
  expect(config).not.toContain('refresh-a')
  expect(state).toContain('access-a')
  expect((await stat(paths.config)).mode & 0o777).toBe(0o600)
  expect((await stat(paths.state)).mode & 0o777).toBe(0o600)
})

test('strict mode cannot be disabled by additional caller options alongside every forwarded seam', async () => {
  const { paths, store } = await fixture()
  await store.initialize()
  await store.add({
    id: 'a',
    identity: 'account-a',
    credential: credential('a'),
  })
  const state = JSON.parse(await readFile(paths.state, 'utf8'))
  delete state.accounts.a.commonAuthPool
  await writeFile(paths.state, JSON.stringify(state))
  const before = await bytes(paths)
  const seams: Pick<
    NativePoolStoreOptions,
    'onStep' | 'hold' | 'logger' | 'onLockEvent' | 'onLockStep'
  > = {
    onStep: () => {},
    hold: () => {},
    logger: { warn: () => {} },
    onLockEvent: () => {},
    onLockStep: () => {},
  }
  const untrustedOptions = {
    paths,
    quota,
    ...seams,
    requireCredentialStamps: false,
  }
  const strict = createNativePoolStore(untrustedOptions)
  expect(await requiredRow(strict)).toMatchObject({
    candidate: false,
    stamp: 'missing',
    unbound: true,
  })
  let providerCalls = 0
  await expect(
    strict.refresh('a', async () => {
      providerCalls++
      return credential('new')
    }),
  ).rejects.toMatchObject({ kind: 'unbound-credential' })
  expect(providerCalls).toBe(0)
  expect(await bytes(paths)).toEqual(before)
})

test('forwards published write, hold, logger and lock seams to real store operations', async () => {
  const { paths } = await fixture()
  const writes: unknown[] = []
  const holds: unknown[] = []
  const warnings: unknown[] = []
  const locks: unknown[] = []
  const lockSteps: unknown[] = []
  const store = createNativePoolStore({
    paths,
    quota,
    onStep: async (step, info) => {
      writes.push({ step, ...info })
    },
    hold: async (point, rowId) => {
      holds.push({ point, rowId })
    },
    logger: {
      warn: (message, data) => {
        warnings.push({ message, data })
      },
    },
    onLockEvent: (event) => {
      locks.push(event)
    },
    onLockStep: async (lock, step) => {
      lockSteps.push({ ...lock, step })
    },
  })
  await store.initialize()
  await store.add({ id: 'a', credential: credential('a') })
  expect(writes).toEqual([
    { step: 'before-state-write', operation: 'add', rowId: 'a' },
    { step: 'after-state-write', operation: 'add', rowId: 'a' },
    { step: 'before-config-write', operation: 'add', rowId: 'a' },
    { step: 'after-config-write', operation: 'add', rowId: 'a' },
  ])
  await expect(
    store.refresh('a', async () => credential('b')),
  ).resolves.toMatchObject({ status: 'rotated' })
  expect(holds).toEqual([{ point: 'refresh-before-provider', rowId: 'a' }])
  await expect(
    store.refresh(
      'a',
      async () => {
        throw new Error('synthetic provider failure')
      },
      {
        onFailure: async () => {
          throw new Error('synthetic hook failure')
        },
      },
    ),
  ).rejects.toMatchObject({ kind: 'provider' })
  expect(warnings).toEqual([
    {
      message: 'store failure hook threw; the original failure stands',
      data: {
        operation: 'refresh',
        rowId: 'a',
        error: 'synthetic hook failure',
      },
    },
  ])
  for (const lock of nativePoolStoreLocks(paths)) {
    expect(locks).toContainEqual({ type: 'acquired', ...lock })
    expect(locks).toContainEqual({ type: 'released', ...lock })
    expect(lockSteps).toContainEqual({
      ...lock,
      step: 'release-owner-confirmed',
    })
  }
})

test('construction, pure reads and migration additions never install a quota pull hook', async () => {
  const { paths } = await fixture()
  let pulls = 0
  let pullFailures = 0
  // Even wider caller objects cannot opt the offline facade into network pulls.
  const untrustedOptions = {
    paths,
    quota,
    pull: async () => {
      pulls++
      throw new Error('unexpected pull')
    },
    onPullFailure: () => {
      pullFailures++
    },
  }
  const store = createNativePoolStore(untrustedOptions)
  await store.pullsSettled()
  expect(pulls).toBe(0)
  await store.read()
  await store.initialize()
  await store.add({ id: 'imported', credential: credential('legacy') })
  await store.read()
  await store.load()
  store.requestReading('imported')
  await store.pullsSettled()
  expect(pulls).toBe(0)
  expect(pullFailures).toBe(0)
  expect(await requiredRow(store)).toMatchObject({
    stamp: 'bound',
    needsFirstReading: true,
  })
})

test('refuses same-epoch access corruption before refresh or observation persistence', async () => {
  const { paths, store } = await fixture()
  await store.initialize()
  await store.add({
    id: 'a',
    identity: 'account-a',
    credential: credential('a'),
  })
  const state = JSON.parse(await readFile(paths.state, 'utf8'))
  state.accounts.a.access = 'foreign-access'
  await writeFile(paths.state, JSON.stringify(state))
  const before = await bytes(paths)
  expect(await requiredRow(store)).toMatchObject({
    candidate: false,
    stamp: 'mismatched',
    unbound: true,
  })
  let providerCalls = 0
  await expect(
    store.refresh('a', async () => {
      providerCalls++
      return credential('new')
    }),
  ).rejects.toMatchObject({ kind: 'unbound-credential' })
  await expect(
    store.recordQuota('a', { credentialEpoch: 1, identity: 'account-a' }, 40),
  ).rejects.toMatchObject({ kind: 'unbound-credential' })
  expect(providerCalls).toBe(0)
  expect(await bytes(paths)).toEqual(before)
})

test('validated replacement recovers unbound material and drops old observations', async () => {
  const { paths, store } = await fixture()
  await store.initialize()
  await store.add({
    id: 'a',
    identity: 'account-a',
    credential: credential('a'),
  })
  await store.recordQuota(
    'a',
    { credentialEpoch: 1, identity: 'account-a' },
    40,
  )
  const state = JSON.parse(await readFile(paths.state, 'utf8'))
  state.accounts.a.access = 'foreign-access'
  await writeFile(paths.state, JSON.stringify(state))
  await store.replace('a', credential('b'), { identity: 'account-b' })
  const replaced = await requiredRow(store)
  expect(replaced).toMatchObject({
    candidate: true,
    stamp: 'bound',
    credentialEpoch: 2,
    identity: 'account-b',
  })
  expect(replaced.quota).toBeUndefined()
  await expect(
    store.recordQuota('a', { credentialEpoch: 1, identity: 'account-a' }, 80),
  ).rejects.toMatchObject({ kind: 'attribution' })
  expect((await requiredRow(store)).quota).toBeUndefined()
})
