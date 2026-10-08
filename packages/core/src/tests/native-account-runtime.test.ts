import { expect, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderAccountUuid } from '../claude-code.ts'
import {
  createNativeAccountRuntime,
  nativeAccountPolicy,
} from '../native-account-runtime.ts'
import {
  createNativeLocalCredentialService,
  type NativeLocalCredentialServiceOptions,
} from '../native-local-credential-service.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import * as runtimeWriter from '../native-runtime.ts'
import { readNativeRuntime } from '../native-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const now = 1_000_000
async function fixture(
  local: Partial<NativeLocalCredentialServiceOptions> = {},
) {
  const parent = new URL(
    '../../../../node_modules/.cache/native-account-runtime/',
    import.meta.url,
  ).pathname
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
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
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: now + 3_600_000,
    },
  })
  await store.updateSettings((settings) => {
    settings.mainAccountId = 'imported-main'
  })
  const counts = { lookups: 0, refresh: 0 }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      now: () => now,
      resolveIdentity: async () => {
        counts.lookups++
        return {
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
          accountUuid: uuid,
        }
      },
      refreshToken: async () => {
        counts.refresh++
        return {
          access: 'synthetic-successor',
          refresh: 'synthetic-new-refresh',
          expires: now + 4_000_000,
          expiresIn: 4000,
        }
      },
      ...local,
    },
  })
  deferCleanup(() => runtime.close())
  return { paths, runtime, store, counts }
}

test('native facade reads no legacy authority and does not import legacy persistence', async () => {
  for (const filename of [
    'native-account-runtime.ts',
    'native-account-view.ts',
    'native-vault-runtime.ts',
  ]) {
    const text = await readFile(
      new URL(`../${filename}`, import.meta.url),
      'utf8',
    )
    const imports =
      text.match(/import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"][^'"]+['"]/g) ??
      []
    expect(imports.join('\n')).not.toMatch(
      /\b(?:saveAccounts|loadAccounts|saveAccountState|FallbackAccountManager|saveOAuthProfileState)\b/,
    )
  }
  const f = await fixture()
  await writeFile(f.paths.legacyConfig, '{ invalid legacy credential source')
  await writeFile(f.paths.legacyState, '{ invalid legacy credential source')
  const read = await f.runtime.read()
  expect(read.accounts[0]?.id).toBe('main')
  expect(f.counts.lookups).toBe(0)
  expect(JSON.stringify(read)).not.toContain('synthetic-access')
  const result = await f.runtime.authorizeLocal('main')
  expect(result.status).toBe('usable')
  expect(f.counts.lookups).toBe(1)
  await f.runtime.authorizeLocal('main')
  expect(f.counts.lookups).toBe(1)
})

test('request-local policy refuses one model without closing another shared account authorization', async () => {
  const f = await fixture()
  await f.runtime.updateSettings((settings) => {
    settings.quota = { enabled: false }
    settings.killswitch = { enabled: false }
  })
  const blocked = await f.runtime.authorizeLocal('main', {
    policy: () => ({ status: 'blocked', reason: 'quota-ineligible' }),
  })
  expect(blocked.status).toBe('refused')
  const allowed = await f.runtime.authorizeLocal('main', {
    policy: (row, snapshot) =>
      nativeAccountPolicy(row, snapshot, 'different-model'),
  })
  expect(allowed.status).toBe('usable')
  expect(f.counts.lookups).toBe(1)
  await f.runtime.setEnabled('main', false)
  expect((await f.runtime.authorizeLocal('main')).status).toBe('refused')
})

test('native background quota/profile authorize positively and refresh one rejected local attempt', async () => {
  const f = await fixture()
  const headers: string[] = []
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      if (headers.length === 1) return new Response('{}', { status: 401 })
      return Response.json(
        String(input).endsWith('/profile')
          ? {
              organization: {
                organization_type: 'claude_pro',
                rate_limit_tier: 'default',
              },
            }
          : {},
      )
    },
    { preconnect: fetch.preconnect },
  )
  const quota = await f.runtime.fetchQuota('main', transport)
  expect(headers).toEqual([
    'Bearer synthetic-access',
    'Bearer synthetic-successor',
  ])
  expect(quota.scoped).toEqual([])
  expect(quota.checkedAt).toBe(now)
  const profile = await f.runtime.fetchProfile('main', transport)
  expect(profile.accountIdentity).toBe(uuid)
  const read = await f.runtime.read()
  expect(read.policyStorage.quota?.mainQuota?.scoped).toEqual([])
  expect(read.policyStorage.main?.profile?.tier).toBe('default')
  expect(f.counts.refresh).toBe(1)
})

test('shared local recovery never captures request model policy', async () => {
  const entered = gate()
  const release = gate()
  const joined = gate()
  let refreshes = 0
  const f = await fixture({
    refreshToken: async () => {
      refreshes++
      entered.open()
      await release.wait
      return {
        access: 'synthetic-shared-successor',
        refresh: 'synthetic-shared-refresh',
        expires: now + 4_000_000,
        expiresIn: 4000,
      }
    },
  })
  await f.store.rotate('imported-main', {
    type: 'oauth',
    access: 'synthetic-expired',
    refresh: 'synthetic-refresh',
    expires: now - 1,
  })
  let allowA = true
  const a = f.runtime.authorizeLocal('main', {
    policy: () =>
      allowA
        ? { status: 'allowed' }
        : { status: 'blocked', reason: 'quota-ineligible' },
  })
  await entered.wait
  const b = f.runtime.authorizeLocal('main', {
    policy: () => {
      joined.open()
      return { status: 'allowed' }
    },
  })
  await joined.wait
  allowA = false
  release.open()
  expect((await a).status).toBe('refused')
  expect((await b).status).toBe('usable')
  expect(refreshes).toBe(1)
})

test('native settings/API create replace and attributed lastUsed leave legacy files untouched', async () => {
  const f = await fixture()
  await f.runtime.updateSettings((settings) => {
    settings.claudeFast = { enabled: true }
  })
  const row = await f.runtime.addApi({
    routeId: 'api-fallback',
    apiKey: 'synthetic-api',
    baseURL: 'https://example.test',
    authHeader: 'x-api-key',
  })
  expect(row.type).toBe('api')
  expect(JSON.stringify(row)).not.toContain('synthetic-api')
  const served = await f.runtime.authorizeApi(row.id)
  expect(served.apiKey).toBe('synthetic-api')
  expect(await f.runtime.publishApi(served.subject, { lastUsed: now })).toBe(
    true,
  )
  await f.runtime.addApi({
    routeId: row.id,
    apiKey: 'synthetic-new-api',
    baseURL: 'https://other.test',
    replace: true,
  })
  expect(
    await f.runtime.publishApi(served.subject, { lastUsed: now + 1 }),
  ).toBe(false)
  expect((await f.runtime.read()).settings.claudeFast).toEqual({
    enabled: true,
  })
  expect(
    await readFile(f.paths.legacyConfig, 'utf8').catch(() => 'missing'),
  ).toBe('missing')
})

test('quota fetch is a physical poll even with persisted quota and persists fixed-text errors against its admitted version', async () => {
  const f = await fixture()
  let polls = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      polls++
      return polls === 2
        ? new Response('synthetic-private-provider-body', { status: 429 })
        : Response.json({})
    },
    { preconnect: fetch.preconnect },
  )
  await f.runtime.fetchQuota('main', transport)
  await expect(f.runtime.fetchQuota('main', transport)).rejects.toThrow('429')
  expect(polls).toBe(2)
  const snapshot = await f.runtime.read()
  expect(snapshot.policyStorage.quota?.mainLastQuotaApiError).toMatchObject({
    status: 429,
    checkedAt: now + 1,
    accountIdentity: uuid,
  })
  expect(await readFile(f.paths.runtime, 'utf8')).not.toContain(
    'synthetic-private-provider-body',
  )
})

test('backoff reset fences exact refresh lineage and monotonically clears native errors', async () => {
  const f = await fixture()
  const attempt = await f.runtime.authorizeLocal('main')
  if (attempt.status !== 'usable') throw new Error('Fixture not admitted')
  await f.runtime.publishLocal(attempt.subject, {
    lastQuotaRefreshError: {
      message: 'fixed',
      checkedAt: now - 1,
      nextRetryAt: now + 100,
      accountIdentity: uuid,
    },
  })
  const old = await f.runtime.captureLocalSubject('main')
  expect(await f.runtime.resetBackoff('main', old, 'quota')).toBe(true)
  expect(
    (await f.runtime.read()).policyStorage.quota?.mainLastQuotaApiError,
  ).toBeUndefined()
  expect(
    (await f.runtime.read()).policyStorage.quota?.mainQuotaErrorGeneration,
  ).toBe(1)
  await f.store.rotate('imported-main', {
    type: 'oauth',
    access: 'synthetic-new-access',
    refresh: 'synthetic-new-lineage',
    expires: now + 4_000_000,
  })
  expect(await f.runtime.resetBackoff('main', old)).toBe(false)
})

test('native lineage and cumulative Prime updates are atomic and replacement fenced', async () => {
  const f = await fixture()
  const result = await f.runtime.authorizeLocal('main')
  if (result.status !== 'usable') throw new Error('Fixture not admitted')
  const lineages = await Promise.all([
    f.runtime.getOrCreateAuthLineage('main', result.subject),
    f.runtime.getOrCreateAuthLineage('main', result.subject),
  ])
  expect(lineages[0]).toBe(lineages[1])
  expect(lineages[0]).toMatch(/^[a-f0-9-]{36}$/)
  await Promise.all([
    f.runtime.incrementPrimeUsage('main', result.subject, { inputTokens: 2 }),
    f.runtime.incrementPrimeUsage('main', result.subject, { outputTokens: 3 }),
  ])
  expect((await f.runtime.read()).accounts[0]?.prime).toEqual({
    count: 2,
    inputTokens: 2,
    outputTokens: 3,
    since: now,
  })
  const subject = await f.runtime.captureLocalSubject('main')
  await f.runtime.loginOAuth({
    routeId: 'main',
    accountIdentity: uuid,
    replace: true,
    credential: {
      access: 'synthetic-relogin',
      refresh: 'synthetic-relogin-refresh',
      expires: now + 4_000_000,
    },
  })
  expect(await f.runtime.resetBackoff('main', subject)).toBe(false)
  expect(await f.runtime.incrementPrimeUsage('main', result.subject)).toBe(
    false,
  )
  const read = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(read.status).toBe('ready')
})

test('missing authority refuses native serving without provider dispatch', async () => {
  const f = await fixture()
  await rm(f.paths.journal)
  await expect(f.runtime.authorizeLocal('main')).rejects.toMatchObject({
    code: 'migration-required',
  })
  expect(f.counts.lookups + f.counts.refresh).toBe(0)
})

test('ordinary native settings cannot switch custody or replace primary activation authority', async () => {
  const f = await fixture()
  await expect(
    f.runtime.updateSettings((settings) => {
      settings.claustrum = { mode: 'claustrum' }
    }),
  ).rejects.toThrow()
  await expect(
    f.runtime.updateSettings((settings) => {
      settings.mainAccountId = 'other'
    }),
  ).rejects.toThrow()
  expect((await f.runtime.read()).mode).toBe('local')
  expect((await f.runtime.read()).settings.mainAccountId).toBe('imported-main')
})

test('normal local refresh preserves Prime lineage and counters but relogin starts a new epoch lineage', async () => {
  const f = await fixture()
  const first = await f.runtime.authorizeLocal('main')
  if (first.status !== 'usable') throw new Error('Fixture not admitted')
  const lineage = await f.runtime.getOrCreateAuthLineage('main', first.subject)
  await f.runtime.incrementPrimeUsage('main', first.subject, { inputTokens: 2 })
  const refreshed = await f.runtime.authorizeLocal('main', {
    rejectedAccessToken: first.access,
  })
  if (refreshed.status !== 'usable')
    throw new Error('Fixture refresh not admitted')
  expect(refreshed.binding.credentialEpoch).toBe(first.binding.credentialEpoch)
  expect(refreshed.subject.credentialFingerprint).not.toBe(
    first.subject.credentialFingerprint,
  )
  expect(
    await f.runtime.getOrCreateAuthLineage('main', refreshed.subject),
  ).toBe(lineage)
  expect((await f.runtime.read()).accounts[0]?.prime?.count).toBe(1)
  await f.runtime.loginOAuth({
    routeId: 'main',
    replace: true,
    accountIdentity: uuid,
    credential: {
      access: 'synthetic-relogin',
      refresh: 'synthetic-relogin-refresh',
      expires: now + 4_000_000,
    },
  })
  const replaced = await f.runtime.authorizeLocal('main')
  if (replaced.status !== 'usable')
    throw new Error('Fixture relogin not admitted')
  expect(replaced.binding.credentialEpoch).toBeGreaterThan(
    first.binding.credentialEpoch,
  )
  expect(
    await f.runtime.getOrCreateAuthLineage('main', replaced.subject),
  ).not.toBe(lineage)
  expect((await f.runtime.read()).accounts[0]?.prime?.count).toBe(1)
})

test('local quota auth failures never arm quota backoff while 429 still does', async () => {
  for (const status of [401, 403, 429]) {
    const f = await fixture()
    const transport: typeof fetch = Object.assign(
      async () => new Response('synthetic-private-body', { status }),
      { preconnect: fetch.preconnect },
    )
    await expect(f.runtime.fetchQuota('main', transport)).rejects.toMatchObject(
      { status },
    )
    const error = (await f.runtime.read()).accounts[0]?.lastQuotaRefreshError
    if (status === 429)
      expect(error).toMatchObject({ status: 429, nextRetryAt: now + 60_000 })
    else expect(error).toBeUndefined()
  }
})

test('local quota retry admits only after deferred body cleanup so disable prevents a second HTTP', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate()
  let http = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      if (++http === 1)
        return new Response(
          new ReadableStream({
            cancel: async () => {
              entered.open()
              await release.wait
            },
          }),
          { status: 401 },
        )
      return Response.json({})
    },
    { preconnect: fetch.preconnect },
  )
  const pending = f.runtime.fetchQuota('main', transport)
  await entered.wait
  await f.runtime.setEnabled('main', false)
  release.open()
  await expect(pending).rejects.toMatchObject({ status: 401 })
  expect(http).toBe(1)
  expect(f.counts.refresh).toBe(0)
})

test('relay transport reads fresh private token while native public snapshots and config stay secret-free', async () => {
  const f = await fixture()
  expect(await f.runtime.getRelayConfig()).toBeNull()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'https://relay.example.test',
    transport: 'http',
    fallbackToDirect: false,
    token: 'synthetic-private-relay-A',
  })
  expect(await f.runtime.getRelayConfig()).toEqual({
    enabled: true,
    url: 'https://relay.example.test',
    transport: 'http',
    fallbackToDirect: false,
    token: 'synthetic-private-relay-A',
  })
  const snapshot = await f.runtime.read()
  expect(JSON.stringify(snapshot)).not.toContain('synthetic-private-relay')
  expect(await readFile(f.paths.config, 'utf8')).not.toContain(
    'synthetic-private-relay',
  )
  expect(snapshot.policyStorage.relay?.token).toBeUndefined()
  await f.runtime.updateRelay({
    token: 'synthetic-private-relay-B',
    url: 'https://new-relay.example.test',
  })
  expect((await f.runtime.getRelayConfig())?.token).toBe(
    'synthetic-private-relay-B',
  )
  expect((await f.runtime.getRelayConfig())?.url).toBe(
    'https://new-relay.example.test',
  )
  await expect(
    f.runtime.updateSettings((settings) => {
      settings.relay = { token: 'synthetic-public-token' }
    }),
  ).rejects.toThrow()
  await f.runtime.updateRelay({ token: null })
  expect(await f.runtime.getRelayConfig()).toBeNull()
  const state = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    state.status === 'ready' ? state.state.relay : undefined,
  ).toBeUndefined()
})

test('interrupted relay private publication leaves relay disabled and old token bound to no dispatch', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'https://old-relay.example.test',
    token: 'synthetic-relay-old',
    transport: 'http',
  })
  const journal = await readFile(f.paths.journal)
  const original = runtimeWriter.updateNativeRuntime
  const hook = spyOn(runtimeWriter, 'updateNativeRuntime').mockImplementation(
    (path, storageId, change, hooks = {}) =>
      original(path, storageId, change, {
        ...hooks,
        beforeRename: async () => {
          await rm(f.paths.journal)
          await hooks.beforeRename?.()
        },
      }),
  )
  deferCleanup(() => hook.mockRestore())
  await expect(
    f.runtime.updateRelay({
      url: 'https://new-relay.example.test',
      token: 'synthetic-relay-new',
    }),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  hook.mockRestore()
  await writeFile(f.paths.journal, journal, { mode: 0o600 })
  expect(await f.runtime.getRelayConfig()).toBeNull()
  const state = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(state.status === 'ready' ? state.state.relay?.token : undefined).toBe(
    'synthetic-relay-old',
  )
  expect(await readFile(f.paths.config, 'utf8')).not.toContain(
    'synthetic-relay-new',
  )
})

test('authorization recovers an interrupted replacement epoch without reusing old validation evidence', async () => {
  const f = await fixture()
  const first = await f.runtime.authorizeLocal('main')
  if (first.status !== 'usable') throw new Error('Fixture not admitted')
  const lineage = await f.runtime.getOrCreateAuthLineage('main', first.subject)
  await f.runtime.incrementPrimeUsage('main', first.subject)
  // Simulate login stopping after PoolStore saves replacement credentials,
  // before recording their runtime binding or verifying their account identity.
  await f.store.replace(
    'imported-main',
    {
      type: 'oauth',
      access: 'synthetic-replaced-access',
      refresh: 'synthetic-replaced-refresh',
      expires: now + 4_000_000,
    },
    { identity: uuid },
  )
  const next = await f.runtime.authorizeLocal('main')
  expect(next.status).toBe('usable')
  expect(f.counts.lookups).toBe(2)
  if (next.status !== 'usable')
    throw new Error('Fixture replacement not admitted')
  expect(next.binding.credentialEpoch).toBeGreaterThan(
    first.binding.credentialEpoch,
  )
  expect(await f.runtime.getOrCreateAuthLineage('main', next.subject)).not.toBe(
    lineage,
  )
  expect((await f.runtime.read()).accounts[0]?.prime?.count).toBe(1)
})

test('private relay access and mutation require current native authority', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    token: 'synthetic-relay-token',
    enabled: true,
    url: 'https://relay.example.test',
    transport: 'http',
  })
  await rm(f.paths.journal)
  await expect(f.runtime.getRelayConfig()).rejects.toMatchObject({
    code: 'migration-required',
  })
  await expect(
    f.runtime.updateRelay({ token: 'synthetic-new-relay-token' }),
  ).rejects.toMatchObject({ code: 'migration-required' })
  expect(await readFile(f.paths.runtime, 'utf8')).not.toContain(
    'synthetic-new-relay-token',
  )
})

test('cross-process remove and readd same native route and UUID creates new Prime lineage and rejects old parent epoch proof', async () => {
  const f = await fixture()
  const first = await f.runtime.authorizeLocal('main')
  if (first.status !== 'usable') throw new Error('Fixture not admitted')
  const lineage = await f.runtime.getOrCreateAuthLineage('main', first.subject)
  await f.runtime.incrementPrimeUsage('main', first.subject)
  // The store refuses reuse of an ID removed by this process. Another process
  // may remove it, after which re-adding it must advance the stored credential
  // generation. Keep the parent's old binding and identity-verification result
  // to prove that neither permits using the replacement credentials.
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { createNativePoolStore } from ${JSON.stringify(new URL('../pool-store.ts', import.meta.url).href)};
    import { nativeQuotaCodec } from ${JSON.stringify(new URL('../native-quota-codec.ts', import.meta.url).href)};
    const store = createNativePoolStore({ paths: ${JSON.stringify(f.paths)}, quota: nativeQuotaCodec });
    await store.remove('imported-main');
    console.log('removed existing native route through public store');
  `,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const cancel = gate()
  const cancellation = cancel.wait.then(() => {
    if (child.exitCode === null) child.kill()
  })
  trackDetached(cancellation)
  try {
    const [exit, out, error] = await Promise.all([child.exited, stdout, stderr])
    expect(exit).toBe(0)
    expect(out.trim()).toBe(
      'removed existing native route through public store',
    )
    expect(error).toBe('')
  } finally {
    // TestLifetime signals cancellation before joining this test body. Terminate
    // the child first so its exit and pipe reads can settle; finish all three
    // promises before cleanup may remove the child's temporary files.
    cancel.open()
    await cancellation
    await Promise.allSettled([child.exited, stdout, stderr])
  }
  expect((await f.runtime.authorizeLocal('main')).status).toBe('refused')
  expect(await f.runtime.publishLocal(first.subject, { lastUsed: now })).toBe(
    false,
  )
  await f.runtime.loginOAuth({
    routeId: 'main',
    accountIdentity: uuid,
    credential: {
      access: 'synthetic-readded-access',
      refresh: 'synthetic-readded-refresh',
      expires: now + 4_000_000,
    },
  })
  const metadata = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  const entry =
    metadata.status === 'ready'
      ? metadata.state.accounts['imported-main']
      : undefined
  expect(entry?.binding).toMatchObject({
    rowId: 'imported-main',
    identity: uuid,
  })
  expect(entry?.credentialValidation).toBeUndefined()
  expect(f.counts.lookups).toBe(1)
  let staleCalls = 0
  const service = createNativeLocalCredentialService({
    paths: f.paths,
    now: () => now,
    externalPolicy: () => ({ status: 'allowed' }),
    failurePolicy: () => ({ checkedAt: now }),
    resolveIdentity: async () => {
      staleCalls++
      return {
        accountUuid: uuid,
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
      }
    },
    refreshToken: async () => {
      staleCalls++
      return {
        access: 'synthetic-never-used',
        refresh: 'synthetic-never-used-refresh',
        expires: now + 4_000_000,
        expiresIn: 4000,
      }
    },
  })
  expect(
    (
      await service.authorize({
        intent: 'serve',
        mode: 'local',
        binding: first.binding,
      })
    ).status,
  ).toBe('refused')
  expect(staleCalls).toBe(0)
  expect(
    await f.runtime.publishLocal(first.subject, { lastUsed: now + 1 }),
  ).toBe(false)
  expect(await f.runtime.incrementPrimeUsage('main', first.subject)).toBe(false)
  const readded = await f.runtime.authorizeLocal('main')
  if (readded.status !== 'usable') throw new Error('Fixture readd not admitted')
  expect(readded.binding.rowId).toBe(first.binding.rowId)
  expect(readded.binding.identity).toBe(first.binding.identity)
  expect(readded.binding.credentialEpoch).toBeGreaterThan(
    first.binding.credentialEpoch,
  )
  expect(f.counts.lookups).toBe(2)
  expect(
    await f.runtime.getOrCreateAuthLineage('main', readded.subject),
  ).not.toBe(lineage)
  expect((await f.runtime.read()).accounts[0]?.prime?.count).toBe(1)
})
