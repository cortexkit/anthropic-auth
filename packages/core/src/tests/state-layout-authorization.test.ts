import { expect } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProviderAccountUuid } from '../claude-code.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeLockEvent } from '../native-lock-observer.ts'
import {
  NativeMigrationError,
  runNativeMigration,
} from '../native-migration.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  type NativePoolPaths,
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
} from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import {
  probeStateHomeServingForTests,
  resetStateHomeServingGuardForTests,
  type StateHomeServingProbe,
} from '../state-home-serving-guard.ts'
import { decideOpenCodeStateLayout } from '../state-layout-decision.ts'
import {
  LEGACY_STATE_LAYOUT,
  resetProcessStateLayoutsForTests,
} from '../state-layout-paths.ts'
import { requestLockProbe } from './native-request-lock-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const now = 1_000_000

// The local credential service accepts exactly these path keys and rejects any
// other own property, so a layout must never become a field of the paths.
const CREDENTIAL_SERVICE_PATH_KEYS = [
  'legacyConfig',
  'legacyState',
  'config',
  'state',
  'runtime',
  'journal',
  'roster',
  'storageId',
]

async function root() {
  const parent = new URL(
    '../../../../node_modules/.cache/state-layout-authorization/',
    import.meta.url,
  ).pathname
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fixture-'))
  deferCleanup(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function migrate(paths: NativePoolPaths, dir: string) {
  return runNativeMigration({
    paths,
    host: 'opencode',
    removePiAnthropicAuth: false,
    hostAuthPath: join(dir, 'host-auth'),
    routingSourcePath: join(dir, 'old-routing'),
    routingDestinationPath: resolveLocalRoutingDestination(
      'opencode',
      paths,
      {},
    ),
    env: {},
    processFence: async () => {},
  })
}

async function addMain(paths: NativePoolPaths) {
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now: () => now,
  })
  await store.initialize()
  await store.add({
    id: 'imported-main',
    identity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-synthetic-access',
      refresh: 'synthetic-refresh',
      expires: now + 3_600_000,
    },
  })
  await store.updateSettings((settings) => {
    settings.mainAccountId = 'imported-main'
  })
  await store.close()
}

function serve(
  paths: NativePoolPaths,
  local: { onLockEvent?: (event: NativeLockEvent) => void } = {},
) {
  const refreshes = { count: 0 }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          paths.legacyConfig,
          '..',
          'opencode-enrollment.json',
        ),
      },
    },
    local: {
      now: () => now,
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid,
      }),
      refreshToken: async () => {
        refreshes.count++
        throw new Error('No refresh expected')
      },
      ...local,
    },
  })
  deferCleanup(async () => {
    await runtime.drainQuotaPublications()
    runtime.close()
  })
  return { runtime, refreshes }
}

async function authorize(paths: NativePoolPaths) {
  await addMain(paths)
  return serve(paths).runtime.authorizeLocal('main')
}

/**
 * A home folder whose OpenCode config folder holds a migrated local pool
 * with one main account, moved into the state folder by a layout decision.
 * Returns both layouts' paths.
 */
async function moved() {
  const dir = await root()
  const home = join(dir, 'home')
  const configDir = join(home, '.config', 'opencode')
  await mkdir(configDir, { recursive: true })
  const env = { XDG_STATE_HOME: join(dir, 'state') }
  const oldPaths = await resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    LEGACY_STATE_LAYOUT,
  )
  await migrate(oldPaths, dir)
  await addMain(oldPaths)
  resetProcessStateLayoutsForTests()
  resetStateHomeServingGuardForTests()
  deferCleanup(() => {
    resetProcessStateLayoutsForTests()
    resetStateHomeServingGuardForTests()
  })
  const decision = await decideOpenCodeStateLayout({
    role: 'opencode2',
    env,
    home,
    artifacts: {
      rpcRoots: [join(dir, 'rpc')],
      rpcDirs: [],
      cacheKeepDirs: [join(dir, 'cachekeep')],
    },
  })
  if (decision.kind !== 'state-home')
    throw new Error(`the fixture did not move: ${JSON.stringify(decision)}`)
  return { oldPaths, newPaths: decision.dataset.newPaths }
}

test('a serving state-home runtime checks for a conflict with lstat only: no marker read and no lock across healthy authorizations', async () => {
  const { newPaths } = await moved()
  const locks = requestLockProbe()
  const { runtime } = serve(newPaths, { onLockEvent: locks.onLockEvent })
  // The first authorization records its credential proof.
  expect((await runtime.authorizeLocal('main')).status).toBe('usable')
  const events: Parameters<StateHomeServingProbe>[0][] = []
  probeStateHomeServingForTests((event) => events.push(event))
  deferCleanup(() => probeStateHomeServingForTests(undefined))
  locks.begin()
  for (let round = 0; round < 2; round++)
    expect((await runtime.authorizeLocal('main')).status).toBe('usable')
  probeStateHomeServingForTests(undefined)
  expect(locks.foreground).toEqual([])
  // Both the runtime's own guard and each authorization's fresh runtime
  // readers checked, and none of them read layout.json again.
  expect(
    events.filter((event) => event.type === 'lstat').length,
  ).toBeGreaterThanOrEqual(4)
  expect(events.filter((event) => event.type === 'read')).toEqual([])
})

test('legacy-layout paths keep the eight captured keys and authorize locally', async () => {
  const dir = await root()
  const config = join(dir, 'anthropic-auth.json')
  const state = join(dir, 'anthropic-auth-state.json')
  const paths = await resolveNativePoolPaths(config, state)
  expect(
    await resolveNativePoolPaths(config, state, LEGACY_STATE_LAYOUT),
  ).toEqual(paths)
  expect(Reflect.ownKeys(paths).sort()).toEqual(
    [...CREDENTIAL_SERVICE_PATH_KEYS].sort(),
  )
  await migrate(paths, dir)
  const result = await authorize(paths)
  expect(result.status).toBe('usable')
})

test('migration refuses paths resolved in a layout other than the process layout', async () => {
  const dir = await root()
  const sub = join(dir, 'state-home')
  await mkdir(sub)
  const config = join(dir, 'anthropic-auth.json')
  const state = join(dir, 'anthropic-auth-state.json')
  const moved = await resolveNativePoolPaths(config, state, {
    kind: 'state-home',
    dir: sub,
  })
  const error = await migrate(moved, dir).catch((caught) => caught)
  expect(error).toBeInstanceOf(NativeMigrationError)
  expect(error).toMatchObject({ code: 'invalid-source' })
  expect(
    (await readdir(sub)).filter((name) => !name.includes('.lock')),
  ).toEqual([])
  // The same call with paths from this process's layout succeeds.
  const legacy = await resolveNativePoolPaths(config, state)
  await expect(migrate(legacy, dir)).resolves.toBeDefined()
})
test('an already serving state-home runtime refuses authorization and refresh once an old copy of the credentials is back, and serves again once it is gone', async () => {
  const { oldPaths, newPaths } = await moved()
  const { runtime, refreshes } = serve(newPaths)
  expect((await runtime.authorizeLocal('main')).status).toBe('usable')
  // An old copy of the credentials is back in the config folder.
  await writeFile(oldPaths.state, await Bun.file(newPaths.state).text())
  await expect(runtime.authorizeLocal('main')).rejects.toMatchObject({
    code: 'conflict',
    paths: [oldPaths.state, newPaths.state],
  })
  await expect(
    runtime.authorizeLocal('main', { intent: 'refresh' }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(refreshes.count).toBe(0)
  await rm(oldPaths.state)
  expect((await runtime.authorizeLocal('main')).status).toBe('usable')
})

test('two serving datasets: a conflict in one stops only that one, and it serves again once repaired', async () => {
  const first = await moved()
  const second = await moved()
  const a = serve(first.newPaths).runtime
  const b = serve(second.newPaths).runtime
  const bothUsable = async () => {
    for (let round = 0; round < 2; round++) {
      expect((await a.authorizeLocal('main')).status).toBe('usable')
      expect((await b.authorizeLocal('main')).status).toBe('usable')
    }
  }
  await bothUsable()
  // An old copy of the first dataset's credentials is back.
  await writeFile(
    first.oldPaths.state,
    await Bun.file(first.newPaths.state).text(),
  )
  for (let round = 0; round < 2; round++) {
    await expect(a.authorizeLocal('main')).rejects.toMatchObject({
      code: 'conflict',
      paths: [first.oldPaths.state, first.newPaths.state],
    })
    expect((await b.authorizeLocal('main')).status).toBe('usable')
  }
  await rm(first.oldPaths.state)
  await bothUsable()
})
