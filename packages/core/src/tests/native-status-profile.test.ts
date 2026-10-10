import { expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { projectVaultRoster } from '@cortexkit/common-auth/claustrum'
import { withLock } from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'
import type { ProviderAccountUuid } from '../claude-code.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeCustodyClient } from '../native-custody.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { createNativeVaultRuntime } from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

// Account and quota displays may show a fetched profile before it is saved.
// fetchProfileForDisplay returns a metadata-only copy as soon as the profile
// response is validated; its `persisted` promise follows the same fenced save
// that fetchProfile still waits for, and reports a failed save without
// rejecting.

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const now = 1_000_000
const tier = 'default_claude_max_5x'

async function fixtureRoot(name: string) {
  const parent = new URL(
    `../../../../node_modules/.cache/${name}/`,
    import.meta.url,
  ).pathname
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
}

async function localFixture() {
  const paths = await fixtureRoot('native-status-profile-local')
  await initializeNativeTestAuthority(paths)
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
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      now: () => now,
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid,
      }),
      refreshToken: async () => {
        throw new Error('This test never refreshes a credential')
      },
    },
  })
  deferCleanup(() => runtime.close())
  return { paths, runtime, store }
}

async function vaultFixture() {
  const paths = await fixtureRoot('native-status-profile-vault')
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  const credentialId = 'oauth:anthropic'
  const projected = projectVaultRoster(
    undefined,
    {
      view: 'initial',
      credentials: [
        {
          credentialId,
          credentialType: 'oauth',
          accountIdentity: uuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now },
  )
  const primaryRouteId = projected.rows[0]?.routeId
  if (!primaryRouteId) throw new Error('Missing fixture primary route')
  await store.updateSettings((settings) => {
    settings.mainAccountId = primaryRouteId
    settings.claustrum = {
      mode: 'claustrum',
      primaryAccount: { credentialId, accountId: uuid, state: 'active' },
    }
  })
  const client: NativeCustodyClient = {
    listScoped: async () => ({
      view: 'view-1',
      rows: [
        {
          id: credentialId,
          accountId: uuid,
          credentialType: 'oauth',
          categories: ['anthropic-native'],
          refreshAdapter: 'anthropic',
          serves: ['anthropic'],
          providerIds: [],
          state: 'active',
          operations: ['read'],
          recordVersion: 7,
          createdAtMs: null,
        },
      ],
    }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: uuid,
      material: 'synthetic-bearer-7',
      recordVersion: 7,
      expiresAtMs: now + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const runtime = createNativeVaultRuntime({
    paths,
    host: 'opencode',
    now: () => now,
    connect: async () => client,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
  })
  deferCleanup(() => runtime.close())
  return { paths, runtime }
}

function profileTransport(
  requests: string[],
  beforeResponse: () => Promise<void> = async () => {},
): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input))
      await beforeResponse()
      return Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: tier,
        },
      })
    },
    { preconnect: fetch.preconnect },
  )
}

function savedRuntimeText(path: string) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const displayProfile = {
  tier,
  orgType: 'claude_max',
  checkedAt: now,
  accountIdentity: uuid,
}

/**
 * Take the pool-config lock that every local metadata write needs and keep it
 * until `release` resolves. Resolves `held` once the lock is owned.
 */
function holdPoolConfigLock(
  paths: Awaited<ReturnType<typeof fixtureRoot>>,
  release: Promise<void>,
) {
  const [config] = nativePoolStoreLocks(paths)
  let acquired!: () => void
  const held = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const work = withLock(
    config.path,
    { ...POOL_LOCK_DEFAULTS, name: config.name },
    async () => {
      acquired()
      await release
    },
  )
  trackDetached(work)
  return { held, work }
}

test('local display profile returns while its save is held, then saves through the fence', async () => {
  const f = await localFixture()
  const requests: string[] = []
  const release = gate()
  let hold: ReturnType<typeof holdPoolConfigLock> | undefined
  const display = await f.runtime.fetchProfileForDisplay(
    'main',
    profileTransport(requests, async () => {
      hold = holdPoolConfigLock(f.paths, release.wait)
      await hold.held
    }),
  )
  let outcome: string | undefined
  const persisted = display.persisted.then((value) => {
    outcome = value
    return value
  })
  expect(requests).toEqual(['https://api.anthropic.com/api/oauth/profile'])
  // Exactly the allowlisted metadata: no bearer, receipt, subject or token
  // fingerprint.
  expect(display.profile).toEqual(displayProfile)
  expect(Object.keys(display).sort()).toEqual(['persisted', 'profile'])
  expect(outcome).toBeUndefined()
  expect(savedRuntimeText(f.paths.runtime)).not.toContain(tier)
  release.open()
  await hold?.work
  expect(await persisted).toBe('saved')
  const read = await f.runtime.read()
  expect(read.accounts.find((row) => row.id === 'main')?.profile?.tier).toBe(
    tier,
  )
})

test('vault display profile returns metadata only and saves through the fence', async () => {
  const f = await vaultFixture()
  const requests: string[] = []
  const display = await f.runtime.fetchProfileForDisplay(
    'main',
    profileTransport(requests),
  )
  expect(requests).toHaveLength(1)
  expect(display.profile).toEqual(displayProfile)
  expect(JSON.stringify(display.profile)).not.toContain('synthetic-bearer')
  expect(await display.persisted).toBe('saved')
  expect(savedRuntimeText(f.paths.runtime)).toContain(tier)
})

test('a save refused by the credential fence resolves failed and stores nothing', async () => {
  const f = await localFixture()
  const display = await f.runtime.fetchProfileForDisplay(
    'main',
    // The account is removed while its profile request is in flight, so the
    // save no longer matches the credential the profile was read with.
    profileTransport([], async () => {
      await f.store.remove('imported-main')
    }),
  )
  expect(display.profile).toEqual(displayProfile)
  expect(await display.persisted).toBe('failed')
  expect(savedRuntimeText(f.paths.runtime)).not.toContain(tier)
})

test('a save that throws resolves failed without an unhandled rejection in a fresh process', async () => {
  const f = await localFixture()
  const script = join(dirname(f.paths.journal), 'persist-failure.ts')
  const coreSource = new URL('../', import.meta.url).pathname
  await writeFile(
    script,
    `import { rmSync } from 'node:fs'
import { createNativeAccountRuntime } from ${JSON.stringify(`${coreSource}native-account-runtime.ts`)}
import { resolveNativePoolPaths } from ${JSON.stringify(`${coreSource}pool-paths.ts`)}
const paths = await resolveNativePoolPaths(${JSON.stringify(f.paths.legacyConfig)})
const runtime = createNativeAccountRuntime({
  paths,
  host: 'opencode',
  local: {
    now: () => ${now},
    resolveIdentity: async () => ({ deviceId: 'd', sessionId: 's', accountUuid: ${JSON.stringify(uuid)} }),
    refreshToken: async () => { throw new Error('no refresh') },
  },
})
const transport = Object.assign(async () => {
  // Removing the authority journal makes the following save throw.
  rmSync(paths.journal)
  return Response.json({ organization: { organization_type: 'claude_max', rate_limit_tier: ${JSON.stringify(tier)} } })
}, { preconnect: fetch.preconnect })
const display = await runtime.fetchProfileForDisplay('main', transport)
console.log('profile', display.profile.tier)
console.log('persisted', await display.persisted)
// Let any stray rejection reach the unhandled-rejection check before exit.
await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setImmediate(resolve))
runtime.close()
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stdout, stderr }).toEqual({
    code: 0,
    stdout: `profile ${tier}\npersisted failed\n`,
    stderr: '',
  })
  expect(savedRuntimeText(f.paths.runtime)).not.toContain(tier)
})

test('missing native authority refuses before any profile request', async () => {
  const f = await localFixture()
  await rm(f.paths.journal, { force: true })
  const requests: string[] = []
  await expect(
    f.runtime.fetchProfileForDisplay('main', profileTransport(requests)),
  ).rejects.toThrow()
  expect(requests).toEqual([])
})

test('fetchProfile keeps waiting for the save before it returns', async () => {
  const f = await localFixture()
  const profile = await f.runtime.fetchProfile('main', profileTransport([]))
  expect(profile.tier).toBe(tier)
  expect(savedRuntimeText(f.paths.runtime)).toContain(tier)
})
