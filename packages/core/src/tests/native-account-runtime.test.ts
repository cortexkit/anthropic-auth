import { expect, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { disconnectClaustrumEnrollment } from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { ClaudeOAuthRefreshError } from '../auth.ts'
import {
  type ProviderAccountUuid,
  resetClaudeCodeIdentityCachesForTest,
} from '../claude-code.ts'
import { custodyTombstoneKey } from '../claustrum.ts'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { TOKEN_URL } from '../constants.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import {
  acquireNativeAccountRuntime,
  createNativeAccountRuntime,
  nativeAccountPolicy,
} from '../native-account-runtime.ts'
import { nativeLocalCredentialValidationMatches } from '../native-credential-validation.ts'
import {
  createNativeLocalCredentialService,
  type NativeLocalCredentialServiceOptions,
} from '../native-local-credential-service.ts'
import { fromNativeQuotaMap, nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  NativeQuotaObservations,
  nativePollQuotaGenerallyExhausted,
} from '../native-quota-observations.ts'
import * as runtimeWriter from '../native-runtime.ts'
import { readNativeRuntime } from '../native-runtime.ts'
import { createNativeUsagePublisher } from '../native-usage-publication.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from '../pool-store.ts'
import { effectiveRelayStatus, effectiveRelayTransport } from '../relay.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { holdNativeRelayLock } from './native-relay-lock-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const now = 1_000_000
const observeBookkeeping = () =>
  new Promise((resolve) => setTimeout(resolve, 200))
async function localSubject(f: Awaited<ReturnType<typeof fixture>>) {
  const admission = await f.runtime.authorizeLocal('main')
  if (admission.status !== 'usable')
    throw new Error('Missing fixture authorization')
  return admission.subject
}
test('local bookkeeping refuses an account replaced immediately before runtime rename', async () => {
  const f = await fixture()
  const subject = await localSubject(f)
  const update = runtimeWriter.updateNativeRuntime
  const writer = spyOn(runtimeWriter, 'updateNativeRuntime').mockImplementation(
    (path, storageId, change, hooks) =>
      update(path, storageId, change, {
        ...hooks,
        beforeRename: async () => {
          await f.store.replace(
            'imported-main',
            {
              type: 'oauth',
              access: 'sk-ant-oat01-replacement-access',
              refresh: 'replacement-refresh',
              expires: now + 3600_000,
            },
            { identity: uuid },
            {
              attribution: {
                credentialEpoch: subject.binding.credentialEpoch,
                identity: uuid,
              },
            },
          )
          await hooks?.beforeRename?.()
        },
      }),
  )
  deferCleanup(() => writer.mockRestore())
  expect(await f.runtime.publishLocal(subject, { lastUsed: now })).toBe(false)
  const pool = await f.store.read()
  expect(
    pool.status === 'ready' && pool.rows[0]?.credentialEpoch,
  ).toBeGreaterThan(subject.binding.credentialEpoch)
  const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    saved.status === 'ready' && saved.state.accounts['imported-main']?.lastUsed,
  ).toBeFalsy()
})

test('local quota coalescer merges poll-owned fields and keeps observation order and newest lastUsed', async () => {
  const f = await fixture()
  const subject = await localSubject(f)
  const poll = {
    source: 'poll' as const,
    accountIdentity: uuid,
    checkedAt: now,
    five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: now },
    scoped: [
      {
        id: 'sonnet',
        title: 'Sonnet',
        modelName: 'Sonnet',
        usedPercent: 30,
        remainingPercent: 70,
        checkedAt: now,
      },
    ],
    bindingWindow: 'sonnet',
    bindingWindowSource: 'poll' as const,
    extraUsage: {
      used: { amountMinor: 1, currency: 'USD', exponent: 2 },
      limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
      exhausted: false,
    },
  }
  const header = {
    source: 'headers' as const,
    accountIdentity: uuid,
    checkedAt: now + 2,
    five_hour: { usedPercent: 90, remainingPercent: 10, checkedAt: now + 2 },
  }
  // Establish the poll before headers; a late older poll deliberately retains
  // the legacy whole-snapshot precedence instead of adding poll-only fields.
  expect(
    await f.runtime.publishLocal(subject, { quota: poll, lastUsed: now + 2 }),
  ).toBe(true)
  expect(
    await f.runtime.publishLocal(subject, { quota: header, lastUsed: now + 1 }),
  ).toBe(true)
  expect(
    await f.runtime.publishLocal(subject, {
      quota: { ...poll, checkedAt: now + 1 },
    }),
  ).toBe(true)
  expect(
    await f.runtime.publishLocal(subject, {
      quota: {
        ...header,
        checkedAt: now + 1,
        five_hour: { usedPercent: 5, remainingPercent: 95, checkedAt: now + 1 },
      },
    }),
  ).toBe(true)
  const account = (await f.runtime.read()).accounts[0]!
  expect(account.quota).toMatchObject({
    five_hour: header.five_hour,
    scoped: poll.scoped,
    bindingWindow: 'sonnet',
    bindingWindowSource: 'poll',
    extraUsage: poll.extraUsage,
    accountIdentity: uuid,
  })
  expect(account.lastUsed).toBe(now + 2)
  expect(
    await f.runtime.publishLocal(subject, {
      quota: {
        ...header,
        checkedAt: now + 3,
        five_hour: { ...header.five_hour, checkedAt: now + 3 },
      },
    }),
  ).toBe(true)
  expect((await f.runtime.read()).accounts[0]?.quota?.scoped).toEqual(
    poll.scoped,
  )
  expect(
    await Promise.all([
      f.runtime.publishLocal(subject, {
        quota: {
          ...header,
          checkedAt: now + 5,
          five_hour: { ...header.five_hour, checkedAt: now + 5 },
        },
      }),
      f.runtime.publishLocal(subject, {
        quota: { ...poll, checkedAt: now + 4 },
      }),
    ]),
  ).toEqual([true, true])
  // Store acceptance does not override the codec: the newer stored snapshot
  // wins as a whole when the accepted poll is older.
  expect((await f.runtime.read()).accounts[0]?.quota?.five_hour).toEqual({
    ...header.five_hour,
    checkedAt: now + 5,
  })
  const scoped = poll.scoped.map((window) => ({
    ...window,
    checkedAt: now + 20,
  }))
  expect(
    await f.runtime.publishLocal(subject, {
      quota: { ...poll, checkedAt: now + 20, scoped },
    }),
  ).toBe(true)
  expect(
    await f.runtime.publishLocal(subject, {
      quota: {
        ...header,
        checkedAt: now + 10,
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          checkedAt: now + 10,
        },
      },
    }),
  ).toBe(true)
  expect((await f.runtime.read()).accounts[0]?.quota).toMatchObject({
    scoped,
    five_hour: { remainingPercent: 50 },
  })
})

test('local runtime metadata combines across handles and each close drains its pool store', async () => {
  const locks: string[] = []
  const onLockEvent = (event: { type: string; name: string }) => {
    if (event.type === 'acquired') locks.push(event.name)
  }
  const f = await fixture({ onLockEvent })
  const subject = await localSubject(f)
  const peer = acquireNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { env: f.env },
    local: { now: () => now, onLockEvent },
  })
  deferCleanup(() => peer.close())
  locks.length = 0
  const quota = {
    source: 'headers' as const,
    accountIdentity: uuid,
    checkedAt: now,
    five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: now },
  }
  const writes = [
    f.runtime.publishLocal(subject, { quota, lastUsed: now }),
    peer.publishLocal(subject, { quota, lastUsed: now + 1 }),
  ]
  await peer.close()
  await f.runtime.close()
  const reader = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { env: f.env },
  })
  deferCleanup(() => reader.close())
  expect((await reader.read()).accounts[0]).toMatchObject({
    lastUsed: now + 1,
    quota: { five_hour: { remainingPercent: 80 } },
  })
  expect(await Promise.all(writes)).toEqual([true, true])
  expect(locks.filter((name) => name === 'pool-config')).toHaveLength(2)
  // Independent runtime owners cannot share a batch that either close may cancel.
  expect(locks.filter((name) => name === 'native-runtime')).toHaveLength(2)
})

test('local readers reject bookkeeping if replacement lands after the final row check', async () => {
  const f = await fixture()
  const subject = await localSubject(f)
  const update = runtimeWriter.updateNativeRuntime
  const writer = spyOn(runtimeWriter, 'updateNativeRuntime').mockImplementation(
    (path, storageId, change, hooks) =>
      update(path, storageId, change, {
        ...hooks,
        beforeRename: async () => {
          await hooks?.beforeRename?.()
          await f.store.replace(
            'imported-main',
            {
              type: 'oauth',
              access: 'sk-ant-oat01-replacement-access',
              refresh: 'replacement-refresh',
              expires: now + 3600_000,
            },
            { identity: uuid },
            {
              attribution: {
                credentialEpoch: subject.binding.credentialEpoch,
                identity: uuid,
              },
            },
          )
        },
      }),
  )
  deferCleanup(() => writer.mockRestore())
  expect(
    await f.runtime.publishLocal(subject, {
      lastUsed: now,
      profile: {
        accountIdentity: uuid,
        checkedAt: now,
        tier: 'max',
        orgType: 'claude_max',
      },
      lastQuotaRefreshError: {
        checkedAt: now,
        message: 'Quota unavailable',
        accountIdentity: uuid,
      },
      quotaErrorClearedAt: now - 1,
      quotaErrorGeneration: 4,
      prime: { count: 3, inputTokens: 10, outputTokens: 20, since: now },
      authLineageId: 'old-lineage',
    }),
  ).toBe(true)
  const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    saved.status === 'ready' && saved.state.accounts['imported-main']?.lastUsed,
  ).toBe(now)
  const pool = await f.store.read()
  expect(
    pool.status === 'ready' && pool.rows[0]?.credentialEpoch,
  ).toBeGreaterThan(subject.binding.credentialEpoch)
  const view = (await f.runtime.read()).accounts[0]!
  for (const field of [
    'lastUsed',
    'profile',
    'lastQuotaRefreshError',
    'quotaErrorClearedAt',
    'quotaErrorGeneration',
    'prime',
  ] as const)
    expect(view[field]).toBeUndefined()
})

for (const lockIndex of [0, 1]) {
  test(`local runtime bookkeeping ignores held pool lock ${lockIndex}`, async () => {
    const f = await fixture()
    const subject = await localSubject(f)
    const spec = nativePoolStoreLocks(f.paths)[lockIndex]!
    const lease = await acquireRefreshFileLock({
      ...spec,
      ttlMs: 60_000,
      renew: true,
    })
    if (!lease) throw new Error('Pool fixture lock unavailable')
    deferCleanup(() => lease.release())
    let finished = false
    const write = f.runtime
      .publishLocal(subject, { lastUsed: now })
      .then((kept) => {
        finished = kept
      })
    trackDetached(write)
    try {
      await observeBookkeeping()
      expect(finished).toBe(true)
      await lease.assertOwned()
    } finally {
      await lease.release()
    }
    await write
  })
}
async function fixture(
  local: Partial<NativeLocalCredentialServiceOptions> = {},
  // Store the main row without an account UUID, as a row whose account was
  // never confirmed.
  unresolved = false,
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
    ...(unresolved ? {} : { identity: uuid }),
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
  const counts = { lookups: 0, refresh: 0 }
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'opencode-enrollment.json',
    ),
  }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: { env },
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
          access: 'sk-ant-oat01-synthetic-successor',
          refresh: 'synthetic-new-refresh',
          expires: now + 4_000_000,
          expiresIn: 4000,
        }
      },
      ...local,
    },
  })
  deferCleanup(async () => {
    await runtime.drainQuotaPublications()
    runtime.close()
  })
  return { paths, runtime, store, counts, env }
}

test('native runtime reports the selected local settings file', async () => {
  const f = await fixture()
  expect(await f.runtime.getSettingsPath()).toBe(f.paths.config)
})

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
  expect(JSON.stringify(read)).not.toContain('sk-ant-oat01-synthetic-access')
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
    'Bearer sk-ant-oat01-synthetic-access',
    'Bearer sk-ant-oat01-synthetic-successor',
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
        access: 'sk-ant-oat01-synthetic-shared-successor',
        refresh: 'synthetic-shared-refresh',
        expires: now + 4_000_000,
        expiresIn: 4000,
      }
    },
  })
  await f.store.rotate('imported-main', {
    type: 'oauth',
    access: 'sk-ant-oat01-synthetic-expired',
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
    access: 'sk-ant-oat01-synthetic-new-access',
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
      access: 'sk-ant-oat01-synthetic-relogin',
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
      access: 'sk-ant-oat01-synthetic-relogin',
      refresh: 'synthetic-relogin-refresh',
      expires: now + 4_000_000,
    },
  })
  const afterLogin = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  if (afterLogin.status !== 'ready')
    throw new Error('Login metadata is missing')
  const nextLineage = afterLogin.state.accounts['imported-main']?.authLineageId
  expect(nextLineage).toMatch(/^[a-f0-9-]{36}$/)
  expect(nextLineage).not.toBe(lineage)
  const replaced = await f.runtime.authorizeLocal('main')
  if (replaced.status !== 'usable')
    throw new Error('Fixture relogin not admitted')
  expect(replaced.binding.credentialEpoch).toBeGreaterThan(
    first.binding.credentialEpoch,
  )
  expect(await f.runtime.getOrCreateAuthLineage('main', replaced.subject)).toBe(
    nextLineage,
  )
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

test('shutdown cancels a failed quota poll waiting to persist its backoff', async () => {
  const f = await fixture()
  await localSubject(f)
  const lease = await acquireRefreshFileLock({
    path: f.paths.runtime,
    name: 'native-runtime',
    ttlMs: 10_000,
  })
  if (!lease) throw new Error('Runtime fixture lock unavailable')
  deferCleanup(() => lease.release())
  const entered = gate()
  const publish = f.runtime.publishLocal
  const observer = spyOn(f.runtime, 'publishLocal').mockImplementation(
    (subject, patch, signal) => {
      const pending = publish(subject, patch, signal)
      if (patch.lastQuotaRefreshError) entered.open()
      return pending
    },
  )
  deferCleanup(() => observer.mockRestore())
  const transport: typeof fetch = Object.assign(
    async () => new Response('rate limited', { status: 429 }),
    { preconnect: fetch.preconnect },
  )
  const poll = f.runtime.fetchQuota('main', transport).then(
    () => false,
    () => true,
  )
  trackDetached(poll)
  await entered.wait
  const closingAt = performance.now()
  await f.runtime.close()
  expect(performance.now() - closingAt).toBeLessThan(1_750)
  expect(await poll).toBe(true)
  await lease.assertOwned()
  const disk = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    disk.status === 'ready' &&
      disk.state.accounts['imported-main']?.lastQuotaRefreshError,
  ).toBeUndefined()
}, 15_000)

test('retiring one lease cancels only its queued metadata behind a live shared poll', async () => {
  const waiting = gate()
  let watching = false
  const onLockEvent = (event: { type: string; name: string }) => {
    if (
      watching &&
      event.type === 'acquiring' &&
      event.name === 'native-runtime'
    )
      waiting.open()
  }
  const f = await fixture({ onLockEvent })
  const subject = await localSubject(f)
  await f.runtime.close()
  const options = {
    paths: f.paths,
    host: 'opencode' as const,
    vault: { env: f.env },
    local: { now: () => now, onLockEvent },
  }
  const a = acquireNativeAccountRuntime(options)
  const b = acquireNativeAccountRuntime(options)
  deferCleanup(() => a.close())
  deferCleanup(() => b.close())
  const holder = await acquireRefreshFileLock({
    path: f.paths.runtime,
    name: 'native-runtime',
    ttlMs: 10_000,
  })
  if (!holder) throw new Error('Runtime fixture lock unavailable')
  deferCleanup(() => holder.release())
  watching = true
  const transport: typeof fetch = Object.assign(async () => Response.json({}), {
    preconnect: fetch.preconnect,
  })
  await b.fetchQuota('main', transport)
  await waiting.wait
  const instance = createNativeUsagePublisher('native-auth')
  instance.publish((signal) =>
    a.publishLocal(subject, { lastUsed: now + 1 }, signal),
  )
  const closingAt = performance.now()
  await Promise.all([instance.close(), a.drainQuotaPublications()])
  await a.close()
  expect(performance.now() - closingAt).toBeLessThan(1_750)
  await holder.assertOwned()
  await holder.release()
  await b.publishLocal(subject, { lastUsed: now + 2 })
  await b.close()
  const disk = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    disk.status === 'ready' && disk.state.accounts['imported-main']?.lastUsed,
  ).toBe(now + 2)
}, 15_000)

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

test('relay config reads published state while another writer holds native-relay', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'https://held.example.test',
    token: 'synthetic-held-token',
  })
  const held = await holdNativeRelayLock(f.paths.config, { deferCleanup })
  try {
    const read = await f.runtime.getRelayConfig().catch(() => null)
    expect(read?.url).toBe('https://held.example.test')
    expect(read?.token).toBe('synthetic-held-token')
    await held.assertOwned()
  } finally {
    await held.pastTimeout
    await held.release()
  }
}, 25_000)

test('relay writer serializes behind a held native-relay writer lease', async () => {
  const f = await fixture()
  const held = await holdNativeRelayLock(f.paths.config, { deferCleanup })
  const entered = gate()
  const original = runtimeWriter.readNativeRuntime
  const hook = spyOn(runtimeWriter, 'readNativeRuntime').mockImplementation(
    async (...args) => {
      entered.open()
      return original(...args)
    },
  )
  deferCleanup(() => hook.mockRestore())
  let settled = false
  const pending = f.runtime
    .updateRelay({
      enabled: true,
      url: 'https://writer.example.test',
      token: 'synthetic-writer-token',
    })
    .then(() => {
      settled = true
    })
  trackDetached(pending)
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(settled).toBe(false)
  expect(await readFile(f.paths.config, 'utf8')).not.toContain(
    'writer.example.test',
  )
  await held.assertOwned()
  await held.release()
  await entered.wait
  await pending
  expect(await f.runtime.getRelayConfig()).toMatchObject({
    url: 'https://writer.example.test',
    token: 'synthetic-writer-token',
  })
})

for (const legacy of [false, true]) {
  test(`relay reader racing a writer never combines old URL and new token (${legacy ? 'legacy' : 'stamped'})`, async () => {
    const f = await fixture()
    await f.runtime.updateRelay({
      enabled: true,
      url: 'https://old.example.test',
      token: 'synthetic-old-token',
    })
    if (legacy) {
      await f.store.updateSettings((settings) => {
        delete (settings.relay as Record<string, unknown>).generation
      })
      await runtimeWriter.updateNativeRuntime(
        f.paths.runtime,
        f.paths.storageId,
        (state) => {
          delete state.relayGeneration
          return state
        },
      )
    }
    const original = runtimeWriter.readNativeRuntime
    let raced = false
    const hook = spyOn(runtimeWriter, 'readNativeRuntime').mockImplementation(
      async (...args) => {
        if (!raced) {
          raced = true
          await f.runtime.updateRelay({
            url: 'https://new.example.test',
            token: 'synthetic-new-token',
          })
        }
        return original(...args)
      },
    )
    deferCleanup(() => hook.mockRestore())
    expect(await f.runtime.getRelayConfig()).toMatchObject({
      url: 'https://new.example.test',
      token: 'synthetic-new-token',
    })
    expect(raced).toBe(true)
  })
}

for (const mismatch of [
  'different',
  'settings-only',
  'runtime-only',
] as const) {
  test(`relay generations that never agree refuse locally (${mismatch})`, async () => {
    const f = await fixture()
    await f.runtime.updateRelay({
      enabled: true,
      url: 'https://private.example.test',
      token: 'synthetic-never-send-token',
    })
    await f.store.updateSettings((settings) => {
      const relay = settings.relay as Record<string, unknown>
      if (mismatch === 'runtime-only') delete relay.generation
      else relay.generation = 'different-generation'
    })
    if (mismatch === 'settings-only')
      await runtimeWriter.updateNativeRuntime(
        f.paths.runtime,
        f.paths.storageId,
        (state) => {
          delete state.relayGeneration
          return state
        },
      )
    await expect(f.runtime.getRelayConfig()).rejects.toMatchObject({
      code: 'relay-inconsistent',
      message:
        'request refused: relay configuration is inconsistent; no request was sent',
    })
  })
}

test('legacy relay pairs remain readable and every writer update stamps both files', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'https://legacy.example.test',
    token: 'synthetic-legacy-relay-token',
  })
  await f.store.updateSettings((settings) => {
    delete (settings.relay as Record<string, unknown>).generation
  })
  await runtimeWriter.updateNativeRuntime(
    f.paths.runtime,
    f.paths.storageId,
    (state) => {
      delete state.relayGeneration
      return state
    },
  )
  expect(await f.runtime.getRelayConfig()).toMatchObject({
    url: 'https://legacy.example.test',
    token: 'synthetic-legacy-relay-token',
  })
  let previous: string | undefined
  for (const patch of [
    { fallbackToDirect: false },
    { url: 'https://new.example.test' },
    { token: null },
  ]) {
    await f.runtime.updateRelay(patch)
    const settings = await f.store.readSettings()
    const runtime = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
    if (settings.status !== 'ready' || runtime.status !== 'ready')
      throw new Error('Fixture not readable')
    const generation = (settings.settings.relay as Record<string, unknown>)
      .generation
    expect(typeof generation).toBe('string')
    expect(generation).not.toBe(previous)
    expect(generation).toBe(runtime.state.relayGeneration)
    previous = runtime.state.relayGeneration
  }
  expect(await f.runtime.getRelayConfig()).toBeNull()
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

test('a stored relay without a transport sends over HTTP and only an explicit websocket selects WebSocket', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'https://relay.example.test',
    transport: 'websocket',
    fallbackToDirect: false,
    token: 'synthetic-private-relay-ws',
  })
  expect((await f.runtime.getRelayConfig())?.transport).toBe('websocket')
  expect(
    effectiveRelayStatus((await f.runtime.read()).policyStorage.relay),
  ).toEqual({ enabled: true, transport: 'websocket' })
  // A configuration saved before the transport field existed, or edited by
  // hand, has no transport at all.
  await f.store.updateSettings((settings) => {
    const { transport: _omitted, ...relay } = settings.relay as Record<
      string,
      unknown
    >
    settings.relay = relay
  })
  const snapshot = await f.runtime.read()
  expect(snapshot.policyStorage.relay?.transport).toBeUndefined()
  expect((await f.runtime.getRelayConfig())?.transport).toBe('http')
  expect(effectiveRelayStatus(snapshot.policyStorage.relay)).toEqual({
    enabled: true,
    transport: 'http',
  })
  // Updating another relay field records the transport requests were using.
  await f.runtime.updateRelay({ fallbackToDirect: true })
  expect((await f.runtime.read()).policyStorage.relay?.transport).toBe('http')
})

test('a stored relay without a transport infers WebSocket from a wss URL, and a stored http transport with a wss URL stays refused', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'wss://relay.example.test',
    transport: 'websocket',
    fallbackToDirect: false,
    token: 'synthetic-private-relay-wss',
  })
  const setTransport = (transport: string | undefined) =>
    f.store.updateSettings((settings) => {
      const { transport: _omitted, ...relay } = settings.relay as Record<
        string,
        unknown
      >
      settings.relay = transport === undefined ? relay : { ...relay, transport }
    })
  await setTransport(undefined)
  const snapshot = await f.runtime.read()
  expect(snapshot.policyStorage.relay?.transport).toBeUndefined()
  expect(effectiveRelayStatus(snapshot.policyStorage.relay)).toEqual({
    enabled: true,
    transport: 'websocket',
  })
  expect(await f.runtime.getRelayConfig()).toMatchObject({
    url: 'wss://relay.example.test',
    transport: 'websocket',
  })
  // An explicit HTTP transport is never overridden by the URL; HTTP cannot
  // send to a WebSocket URL, so the configuration is refused.
  await setTransport('http')
  await expect(f.runtime.getRelayConfig()).rejects.toMatchObject({
    code: 'publication-refused',
  })
})

test('a relay without its private token is unusable for both dispatch and the status display', async () => {
  const f = await fixture()
  await f.runtime.updateRelay({
    enabled: true,
    url: 'https://relay.example.test',
    transport: 'http',
    token: 'synthetic-private-relay-gone',
  })
  const configured = (await f.runtime.read()).policyStorage.relay
  expect(configured?.tokenConfigured).toBe(true)
  expect(effectiveRelayStatus(configured)).toEqual({
    enabled: true,
    transport: 'http',
  })
  // Lose only the private token; the public settings still say enabled.
  await runtimeWriter.updateNativeRuntime(
    f.paths.runtime,
    f.paths.storageId,
    (state) => {
      delete state.relay
      return state
    },
  )
  const snapshot = await f.runtime.read()
  expect(snapshot.policyStorage.relay).toMatchObject({
    enabled: true,
    url: 'https://relay.example.test',
    tokenConfigured: false,
  })
  expect(await f.runtime.getRelayConfig()).toBeNull()
  expect(effectiveRelayStatus(snapshot.policyStorage.relay)).toBeNull()
})

test('effective relay transport and status follow the stored values', () => {
  const https = 'https://relay.example.test'
  const wss = 'wss://relay.example.test'
  expect(effectiveRelayTransport(undefined, https)).toBe('http')
  expect(effectiveRelayTransport(undefined, 'http://relay.example.test')).toBe(
    'http',
  )
  expect(effectiveRelayTransport(undefined, undefined)).toBe('http')
  // A missing transport is inferred from a WebSocket URL scheme.
  expect(effectiveRelayTransport(undefined, wss)).toBe('websocket')
  expect(effectiveRelayTransport(undefined, ' WS://relay.example.test')).toBe(
    'websocket',
  )
  // A stored transport wins over the URL scheme.
  expect(effectiveRelayTransport('http', wss)).toBe('http')
  expect(effectiveRelayTransport('websocket', https)).toBe('websocket')
  // An unrecognized stored value counts as missing.
  expect(effectiveRelayTransport('ws', https)).toBe('http')
  expect(effectiveRelayTransport('ws', wss)).toBe('websocket')
  const relay = { enabled: true, url: https }
  expect(
    effectiveRelayStatus({ ...relay, url: wss, tokenConfigured: true }),
  ).toEqual({ enabled: true, transport: 'websocket' })
  expect(effectiveRelayStatus(undefined)).toBeNull()
  expect(effectiveRelayStatus(relay)).toBeNull()
  expect(effectiveRelayStatus({ ...relay, token: ' ' })).toBeNull()
  expect(effectiveRelayStatus({ ...relay, token: 'legacy-token' })).toEqual({
    enabled: true,
    transport: 'http',
  })
  expect(
    effectiveRelayStatus({
      ...relay,
      tokenConfigured: true,
      transport: 'websocket',
    }),
  ).toEqual({ enabled: true, transport: 'websocket' })
  expect(
    effectiveRelayStatus({ ...relay, enabled: false, tokenConfigured: true }),
  ).toBeNull()
  expect(
    effectiveRelayStatus({ ...relay, url: ' ', tokenConfigured: true }),
  ).toBeNull()
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
      access: 'sk-ant-oat01-synthetic-replaced-access',
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
      access: 'sk-ant-oat01-synthetic-readded-access',
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
  // Login verifies the successor before saving it. Serving still requires a
  // positive proof bound to the newly committed epoch, not the parent's proof.
  expect(f.counts.lookups).toBe(2)
  let staleCalls = 0
  const service = createNativeLocalCredentialService({
    paths: f.paths,
    now: () => now,
    publicationGuard: async () => true,
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
        access: 'sk-ant-oat01-synthetic-never-used',
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
  expect(f.counts.lookups).toBe(3)
  expect(
    await f.runtime.getOrCreateAuthLineage('main', readded.subject),
  ).not.toBe(lineage)
  expect((await f.runtime.read()).accounts[0]?.prime?.count).toBe(1)
})

/**
 * Capture the INFO records the runtime emits on the `commands` channel. The
 * live logger level starts at info and the previous level and sink are
 * restored after the test. Bun runs tests with NODE_ENV=test, under which the
 * logger delivers records only to this sink and writes no log file.
 */
function captureCommandLogs() {
  expect(process.env.NODE_ENV).toBe('test')
  const previousLevel = getLogLevel()
  const records: LogTestRecord[] = []
  setLogLevel('info')
  __setLogTestSink((record) => {
    if (record.channel === 'commands') records.push(record)
  })
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return {
    /** Records captured since the previous call, as message and payload. */
    take() {
      const taken = records.map(({ level, message, payload }) => ({
        level,
        message,
        payload,
      }))
      records.length = 0
      return taken
    },
  }
}

test('committed killswitch changes log once, and the thresholds payload holds only numeric threshold fields', async () => {
  const f = await fixture()
  const logs = captureCommandLogs()

  await f.runtime.updateSettings((settings) => {
    settings.killswitch = {
      enabled: true,
      main: { five_hour: 3, seven_day: 8 },
    }
  })
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'killswitch changed',
      payload: { enabled: true },
    },
    {
      level: 'info',
      message: 'killswitch thresholds changed',
      payload: { thresholds: { five_hour: 3, seven_day: 8 } },
    },
  ])

  // Writing the same values again leaves the settings unchanged, so nothing
  // is logged.
  await f.runtime.updateSettings((settings) => ({
    ...settings,
    killswitch: { enabled: true, main: { five_hour: 3, seven_day: 8 } },
  }))
  expect(logs.take()).toEqual([])

  // Turning the switch off keeps the thresholds, so only the switch is logged.
  await f.runtime.updateSettings((settings) => ({
    ...settings,
    killswitch: { ...(settings.killswitch as object), enabled: false },
  }))
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'killswitch changed',
      payload: { enabled: false },
    },
  ])

  // Settings are hand-editable JSON, so a killswitch entry may hold other
  // fields, including secret-looking ones. Adding only such fields is not a
  // threshold change, so nothing is logged, and the threshold logs below
  // must not contain them either.
  const leaks = {
    token: 'sk-ant-leak-token',
    note: 'Bearer leak-bearer',
    nested: { refresh: 'leak-refresh' },
    five_hour_text: 'leak-text',
  }
  await f.runtime.updateSettings((settings) => ({
    ...settings,
    killswitch: {
      enabled: false,
      main: { five_hour: 3, seven_day: 8, ...leaks },
    },
  }))
  expect(logs.take()).toEqual([])
  await f.runtime.updateSettings((settings) => ({
    ...settings,
    killswitch: {
      enabled: false,
      main: { five_hour: 4, seven_day: 'nine', '1w': 9, ...leaks },
    },
  }))
  // Without main thresholds, the per-account thresholds are logged instead.
  await f.runtime.updateSettings((settings) => ({
    ...settings,
    killswitch: {
      enabled: false,
      accounts: { 'fallback-a': { scoped: 2, ...leaks }, broken: 'leak-entry' },
    },
  }))
  const thresholdLogs = logs.take()
  expect(thresholdLogs).toEqual([
    {
      level: 'info',
      message: 'killswitch thresholds changed',
      payload: { thresholds: { five_hour: 4, '1w': 9 } },
    },
    {
      level: 'info',
      message: 'killswitch thresholds changed',
      payload: { thresholds: { 'fallback-a': { scoped: 2 } } },
    },
  ])
  expect(JSON.stringify(thresholdLogs)).not.toContain('leak')
})

test('setLoggingLevel stores the level and aligns the live logger level once, including when only the live level differs', async () => {
  const f = await fixture()
  const logs = captureCommandLogs()
  const stored = async () => (await f.runtime.read()).settings.logging

  // A new stored level changes the live level and is logged once.
  await f.runtime.setLoggingLevel('debug')
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'log level changed',
      payload: { level: 'debug' },
    },
  ])
  expect(getLogLevel()).toBe('debug')
  expect(await stored()).toEqual({ level: 'debug' })

  // The record of a change to warn is written while debug is still live, so
  // lowering the verbosity is still logged.
  await f.runtime.setLoggingLevel('warn')
  expect(logs.take()).toEqual([
    { level: 'info', message: 'log level changed', payload: { level: 'warn' } },
  ])
  expect(getLogLevel()).toBe('warn')

  // Selecting the level that is both stored and live changes nothing.
  await f.runtime.setLoggingLevel('warn')
  expect(logs.take()).toEqual([])
  expect(getLogLevel()).toBe('warn')

  // Something else in the process changed the live level. Writes of other
  // settings, or of the same stored level through updateSettings, leave it.
  setLogLevel('info')
  await f.runtime.updateSettings((settings) => {
    settings.dump = { enabled: true }
  })
  await f.runtime.updateSettings((settings) => {
    settings.logging = { level: 'warn' }
  })
  expect(logs.take()).toEqual([])
  expect(getLogLevel()).toBe('info')

  // Selecting the stored level again brings the live level back to it.
  await f.runtime.setLoggingLevel('warn')
  expect(logs.take()).toEqual([
    { level: 'info', message: 'log level changed', payload: { level: 'warn' } },
  ])
  expect(getLogLevel()).toBe('warn')
  expect(await stored()).toEqual({ level: 'warn' })
})

test('refused or failed settings writes log nothing and leave the live level unchanged', async () => {
  const f = await fixture()
  const logs = captureCommandLogs()

  // The mutator throws after editing its copy, so nothing is written.
  await expect(
    f.runtime.updateSettings((settings) => {
      settings.logging = { level: 'trace' }
      settings.killswitch = { enabled: true }
      throw new Error('synthetic mutator failure')
    }),
  ).rejects.toThrow('synthetic mutator failure')
  // The runtime refuses a settings write that would also change which account
  // is main, so nothing is written.
  await expect(
    f.runtime.updateSettings((settings) => {
      settings.logging = { level: 'trace' }
      settings.killswitch = { enabled: true }
      settings.mainAccountId = 'other'
    }),
  ).rejects.toThrow()
  // setLoggingLevel applies nothing when its settings write fails.
  const write = spyOn(f.runtime, 'updateSettings').mockImplementationOnce(() =>
    Promise.reject(new Error('synthetic write failure')),
  )
  deferCleanup(() => write.mockRestore())
  await expect(f.runtime.setLoggingLevel('trace')).rejects.toThrow(
    'synthetic write failure',
  )
  expect(write).toHaveBeenCalledTimes(1)

  expect(logs.take()).toEqual([])
  expect(getLogLevel()).toBe('info')
  const stored = (await f.runtime.read()).settings
  expect(stored.logging).toBeUndefined()
  expect(stored.killswitch).toBeUndefined()
})

test('committed account enable, disable, remove and reorder log the changed account without credential material', async () => {
  const f = await fixture()
  for (const [routeId, label] of [
    ['fallback-a', 'Work'],
    ['fallback-b', undefined],
  ] as const)
    await f.runtime.addApi({
      routeId,
      apiKey: `synthetic-api-${routeId}`,
      ...(label && { label }),
    })
  const logs = captureCommandLogs()

  await f.runtime.setEnabled('fallback-a', false)
  await f.runtime.setEnabled('fallback-a', false)
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'account disabled',
      payload: { id: 'fallback-a', label: 'Work', enabled: false },
    },
  ])
  await f.runtime.setEnabled('fallback-a', true)
  await f.runtime.setEnabled('fallback-a', true)
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'account enabled',
      payload: { id: 'fallback-a', label: 'Work', enabled: true },
    },
  ])

  const fallbackOrder = async () =>
    (await f.runtime.read()).accounts
      .filter((row) => row.id !== 'main')
      .map((row) => row.id)
  expect(await fallbackOrder()).toEqual(['fallback-a', 'fallback-b'])
  await f.runtime.reorder(['fallback-b', 'fallback-a'], 'fallback-b')
  expect(await fallbackOrder()).toEqual(['fallback-b', 'fallback-a'])
  // Asking for the order that is already stored writes nothing, so only the
  // first reorder above is logged.
  await f.runtime.reorder(['fallback-b', 'fallback-a'], 'fallback-b')
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'account reordered',
      payload: { id: 'fallback-b', label: undefined },
    },
  ])

  // Removing or disabling an account id that does not exist is refused, and
  // nothing is logged.
  await expect(f.runtime.remove('missing-route')).rejects.toThrow()
  await expect(f.runtime.setEnabled('missing-route', false)).rejects.toThrow()
  expect(logs.take()).toEqual([])

  await f.runtime.remove('fallback-a')
  expect(await fallbackOrder()).toEqual(['fallback-b'])
  const removed = logs.take()
  expect(removed).toEqual([
    {
      level: 'info',
      message: 'account removed',
      payload: { id: 'fallback-a', label: 'Work' },
    },
  ])
  expect(JSON.stringify(removed)).not.toContain('synthetic-api')
})

test('only an add that creates a new account row logs account added, without credential material', async () => {
  const f = await fixture()
  const logs = captureCommandLogs()

  await f.runtime.addApi({
    routeId: 'fallback-a',
    apiKey: 'synthetic-api-secret-a',
    baseURL: 'https://example.test',
    authHeader: 'x-api-key',
    label: 'Work',
  })
  const added = logs.take()
  expect(added).toEqual([
    {
      level: 'info',
      message: 'account added',
      payload: { id: 'fallback-a', label: 'Work', type: 'apikey' },
    },
  ])
  const text = JSON.stringify(added)
  for (const secret of ['synthetic-api-secret-a', 'example.test', 'x-api-key'])
    expect(text).not.toContain(secret)

  // Replacing the credential of an existing account id creates no account.
  await f.runtime.addApi({
    routeId: 'fallback-a',
    apiKey: 'synthetic-api-secret-b',
    replace: true,
  })
  // Adding a key that is already stored, under a new account id, updates the
  // account that holds it instead of creating one.
  await f.runtime.addApi({
    routeId: 'fallback-dup',
    apiKey: 'synthetic-api-secret-b',
  })
  // An add to an existing account id without replace is refused.
  await expect(
    f.runtime.addApi({ routeId: 'fallback-a', apiKey: 'synthetic-api-other' }),
  ).rejects.toThrow()
  expect(logs.take()).toEqual([])
  expect(
    (await f.runtime.read()).accounts
      .filter((row) => row.id !== 'main')
      .map((row) => row.id),
  ).toEqual(['fallback-a'])

  await f.runtime.loginOAuth({
    routeId: 'fallback-oauth',
    credential: {
      access: 'sk-ant-oat01-synthetic-oauth-access',
      refresh: 'synthetic-oauth-refresh',
      expires: now + 3_600_000,
    },
  })
  const oauth = logs.take()
  expect(oauth).toEqual([
    {
      level: 'info',
      message: 'account added',
      payload: { id: 'fallback-oauth', label: undefined, type: 'oauth' },
    },
  ])
  expect(JSON.stringify(oauth)).not.toContain('synthetic-oauth')
})

test('two writers enabling the same disabled account log one change, judged by the write rather than an earlier read', async () => {
  const f = await fixture()
  await f.runtime.addApi({
    routeId: 'fallback-a',
    apiKey: 'synthetic-api-fallback-a',
    label: 'Work',
  })
  await f.runtime.setEnabled('fallback-a', false)
  // A second account runtime shares the same credential/configuration files,
  // representing another process.
  const other = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { env: f.env },
  })
  deferCleanup(() => other.close())
  const logs = captureCommandLogs()

  // Writer A reads the account while it is still disabled. Before A writes,
  // writer B enables the account completely; A's enable then changes nothing.
  const read = f.runtime.read.bind(f.runtime)
  let interleaved = false
  const readSpy = spyOn(f.runtime, 'read').mockImplementation(async () => {
    const snapshot = await read()
    if (!interleaved) {
      interleaved = true
      expect(
        snapshot.accounts.find((row) => row.id === 'fallback-a')?.enabled,
      ).toBe(false)
      await other.setEnabled('fallback-a', true)
    }
    return snapshot
  })
  deferCleanup(() => readSpy.mockRestore())
  await f.runtime.setEnabled('fallback-a', true)
  readSpy.mockRestore()

  expect(interleaved).toBe(true)
  expect(
    (await f.runtime.read()).accounts.find((row) => row.id === 'fallback-a')
      ?.enabled,
  ).toBe(true)
  // Only writer B changed the account.
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'account enabled',
      payload: { id: 'fallback-a', label: 'Work', enabled: true },
    },
  ])

  // A change made without interference is still logged once.
  await f.runtime.setEnabled('fallback-a', false)
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'account disabled',
      payload: { id: 'fallback-a', label: 'Work', enabled: false },
    },
  ])
})

test('local enable and disable log only a flag change made by their own write', async () => {
  const f = await fixture()
  await f.runtime.addApi({
    routeId: 'fallback-a',
    apiKey: 'synthetic-api-fallback-a',
    label: 'Work',
  })
  const poolRow = async (id: string) => {
    const read = await f.store.read()
    if (read.status !== 'ready') throw new Error('Fixture pool unreadable')
    const row = read.rows.find((row) => row.id === id)
    if (!row) throw new Error(`Missing fixture row ${id}`)
    return row
  }
  // Interrupt a credential replacement after its state write, leaving the
  // row torn: the next write on the pool first repairs it with its own
  // config write.
  const tear = async (id: string) => {
    const row = await poolRow(id)
    const credentialEpoch = row.credentialEpoch
    if (credentialEpoch === undefined)
      throw new Error(`Fixture row ${id} has no credential epoch`)
    const crashing = createNativePoolStore({
      paths: f.paths,
      quota: nativeQuotaCodec,
      now: () => now,
      onStep: async (step, info) => {
        if (step === 'before-config-write' && info.operation === 'replace')
          throw new Error('synthetic interrupted replace')
      },
    })
    await expect(
      crashing.replace(
        id,
        {
          type: 'api',
          apiKey: `synthetic-api-${id}-replacement`,
          baseURL: 'https://api.anthropic.com',
        },
        {},
        {
          attribution: { credentialEpoch, identity: row.identity },
        },
      ),
    ).rejects.toThrow()
    expect((await poolRow(id)).torn).toBe(true)
  }
  const logs = captureCommandLogs()

  // The interrupted replacement saved credentials but not the matching config.
  // Repair writes that config; the account was already enabled, so no toggle occurs.
  await tear('fallback-a')
  await f.runtime.setEnabled('fallback-a', true)
  expect((await poolRow('fallback-a')).torn).toBeUndefined()
  expect(logs.take()).toEqual([])

  // After repairing the interrupted replacement, enabling a disabled account
  // changes its flag once and must produce exactly one change log.
  await f.runtime.setEnabled('fallback-a', false)
  logs.take()
  await tear('fallback-a')
  await f.runtime.setEnabled('fallback-a', true)
  expect((await poolRow('fallback-a')).enabled).toBe(true)
  expect(logs.take()).toEqual([
    {
      level: 'info',
      message: 'account enabled',
      payload: { id: 'fallback-a', label: 'Work', enabled: true },
    },
  ])

  // Enabling clears a leftover disabled reason so it no longer describes the
  // active account. This maintenance write does not change the enabled flag.
  const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
  config.commonAuthPool.rows['fallback-a'].disabledReason = 'synthetic-reason'
  await writeFile(f.paths.config, JSON.stringify(config))
  expect((await poolRow('fallback-a')).disabledReason).toBe('synthetic-reason')
  await f.runtime.setEnabled('fallback-a', true)
  expect((await poolRow('fallback-a')).disabledReason).toBeUndefined()
  expect(logs.take()).toEqual([])

  // Duplicate OAuth identities cannot be active twice in the pool. A fallback
  // matching the active main account stays disabled and produces no change log.
  await f.store.add({
    id: 'fallback-dup',
    identity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-synthetic-dup-access',
      refresh: 'synthetic-dup-refresh',
      expires: now + 3_600_000,
    },
  })
  expect((await poolRow('fallback-dup')).enabled).toBe(false)
  await expect(f.runtime.setEnabled('fallback-dup', true)).rejects.toThrow()
  expect(logs.take()).toEqual([])
})

for (const rotate of [false, true]) {
  test(`profile writer I/O failure rechecks the current credential (rotation=${rotate})`, async () => {
    const f = await fixture()
    expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
    const before = await readFile(f.paths.runtime)
    const original = filesystem.rename
    let failedWrites = 0
    // Account/token checks reject superseded credentials, and lock checks reject
    // a superseded writer. Inject a failed rename only after those checks pass
    // to isolate a storage failure from a refused publication.
    const writer = spyOn(filesystem, 'rename').mockImplementation(
      async (from, to) => {
        if (to === f.paths.runtime) {
          failedWrites++
          throw Object.assign(new Error('Synthetic runtime rename failure'), {
            code: 'EIO',
          })
        }
        await original(from, to)
      },
    )
    deferCleanup(() => writer.mockRestore())
    const transport = Object.assign(
      async () =>
        Response.json({
          organization: {
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_20x',
          },
        }),
      { preconnect() {} },
    )
    const result = await f.runtime.fetchProfileForDisplay('main', transport)
    expect(await result.persisted).toBe('failed')
    expect(failedWrites).toBe(1)
    expect(await readFile(f.paths.runtime)).toEqual(before)
    writer.mockRestore()
    if (rotate)
      await f.store.rotate('imported-main', {
        type: 'oauth',
        access: 'sk-ant-oat01-different-profile-version',
        refresh: 'different-profile-refresh',
        expires: now + 8_000_000,
      })
    expect(await result.isCurrent()).toBe(!rotate)
    expect(result.profile.tier).toBe('default_claude_max_20x')
  })
}

test('late profile publication refusal cannot authorize display for rotated credentials', async () => {
  const f = await fixture()
  expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
  const transport = Object.assign(
    async () => {
      await f.store.rotate('imported-main', {
        type: 'oauth',
        access: 'sk-ant-oat01-profile-refusal-successor',
        refresh: 'profile-refusal-refresh',
        expires: now + 8_000_000,
      })
      return Response.json({
        organization: {
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
        },
      })
    },
    { preconnect() {} },
  )
  const result = await f.runtime.fetchProfileForDisplay('main', transport)
  expect(await result.persisted).toBe('refused')
  expect(await result.isCurrent()).toBe(false)
  expect(
    (await f.runtime.read()).accounts.find((account) => account.id === 'main')
      ?.profile,
  ).toBeUndefined()
})

for (const [status, failCount, expectedAttempts, expectedStatus] of [
  [500, 1, 2, 'usable'],
  [500, 3, 3, 'failed'],
  [429, 3, 1, 'failed'],
  [403, 3, 1, 'failed'],
] as const) {
  test(`native refresh keeps bounded provider attempts before backoff (status=${status}, failures=${failCount})`, async () => {
    let attempts = 0
    const f = await fixture({
      refreshToken: async (input) => {
        expect(input.maxRetries).toBe(0)
        attempts++
        if (attempts <= failCount)
          throw new ClaudeOAuthRefreshError(
            status,
            'Synthetic provider failure',
          )
        return {
          access: 'sk-ant-oat01-retry-successor',
          refresh: 'retry-successor-refresh',
          expires: now + 8_000_000,
          expiresIn: 8000,
        }
      },
    })
    const result = await f.runtime.authorizeLocal('main', { intent: 'refresh' })
    expect(attempts).toBe(expectedAttempts)
    expect(result.status).toBe(expectedStatus)
    const state = await f.runtime.read()
    const error = state.accounts.find(
      (row) => row.id === 'main',
    )?.lastRefreshError
    if (expectedStatus === 'usable') {
      if (result.status !== 'usable')
        throw new Error('Expected usable successor')
      expect(result.access).toBe('sk-ant-oat01-retry-successor')
      expect(error).toBeUndefined()
    } else {
      expect(error?.nextRetryAt).toBeGreaterThan(now)
      expect(error?.retryCount).toBe(expectedAttempts)
      await f.runtime.authorizeLocal('main', { intent: 'refresh' })
      expect(attempts).toBe(expectedAttempts)
    }
  })
}

test('native network refresh failure permits one retry and clears its transient error on success', async () => {
  let attempts = 0
  const f = await fixture({
    refreshToken: async (input) => {
      expect(input.maxRetries).toBe(0)
      if (++attempts === 1)
        throw Object.assign(new Error('Synthetic socket reset'), {
          code: 'ECONNRESET',
        })
      return {
        access: 'sk-ant-oat01-network-successor',
        refresh: 'network-successor-refresh',
        expires: now + 8_000_000,
        expiresIn: 8000,
      }
    },
  })
  const result = await f.runtime.authorizeLocal('main', { intent: 'refresh' })
  expect(attempts).toBe(2)
  expect(result.status).toBe('usable')
  expect(
    (await f.runtime.read()).accounts.find((row) => row.id === 'main')
      ?.lastRefreshError,
  ).toBeUndefined()
})

test('vault mode refuses direct local API authorization without changing stored rows and disconnect restores it', async () => {
  const f = await fixture()
  await f.runtime.addApi({
    routeId: 'local-api',
    apiKey: 'synthetic-local-api-secret',
  })
  const enrollment = getHostClaustrumEnrollmentPaths('opencode', f.env)
  await writeFile(
    enrollment.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  expect(await f.runtime.getSettingsPath()).toBe(
    nativeVaultPaths(f.paths).config,
  )
  const before = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  await expect(f.runtime.authorizeApi('local-api')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(before)
  expect(f.counts.lookups + f.counts.refresh).toBe(0)
  expect(
    await disconnectClaustrumEnrollment(enrollment, 'anthropic-auth-opencode'),
  ).toBe('disconnected')
  expect((await f.runtime.authorizeApi('local-api')).apiKey).toBe(
    'synthetic-local-api-secret',
  )
})

test('OAuth login validates fresh identity before replacing the pool credential', async () => {
  const presented: string[] = []
  const f = await fixture({
    resolveIdentity: async (access) => {
      presented.push(access)
      return {
        deviceId: 'login-device',
        sessionId: 'login-session',
        accountUuid: uuid,
      }
    },
  })
  await f.runtime.loginOAuth({
    routeId: 'main',
    credential: {
      access: 'sk-ant-oat01-login-successor',
      refresh: 'login-successor-refresh',
      expires: now + 18_000_000,
    },
  })
  expect(presented).toEqual(['sk-ant-oat01-login-successor'])
  const saved = await f.store.read()
  if (saved.status !== 'ready') throw new Error('Login pool was not readable')
  expect(saved.rows.find((row) => row.id === 'imported-main')).toMatchObject({
    identity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-login-successor',
      refresh: 'login-successor-refresh',
    },
  })
})

test('OAuth login stores only the token fields under the oauth type', async () => {
  const f = await fixture()
  // A token-exchange result has its own `type` and may carry other fields.
  // Neither may reach the stored credential.
  const exchanged = {
    type: 'success',
    access: 'sk-ant-oat01-exchange-result-access',
    refresh: 'exchange-result-refresh',
    expires: now + 18_000_000,
    extra: 'exchange-result-extra-field',
  }
  const account = await f.runtime.loginOAuth({
    routeId: 'exchange-result-route',
    label: 'Exchange result',
    credential: exchanged,
  })
  expect(account).toMatchObject({ type: 'oauth', label: 'Exchange result' })
  const saved = await f.store.read()
  if (saved.status !== 'ready') throw new Error('Login pool was not readable')
  const row = saved.rows.find((row) => row.id === account.binding?.rowId)
  expect(row?.credential).toMatchObject({
    type: 'oauth',
    access: 'sk-ant-oat01-exchange-result-access',
    refresh: 'exchange-result-refresh',
    expires: now + 18_000_000,
  })
  expect(row?.credential).not.toHaveProperty('extra')
  const files = await Promise.all(
    [f.paths.config, f.paths.state].map((path) => readFile(path, 'utf8')),
  )
  expect(files.join('\n')).not.toContain('exchange-result-extra-field')
})

async function loginStoredBytes(
  paths: Awaited<ReturnType<typeof fixture>>['paths'],
) {
  return Promise.all(
    [paths.config, paths.state, paths.runtime].map(async (path) => {
      try {
        return await readFile(path)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return undefined
        throw error
      }
    }),
  )
}

for (const failure of ['missing-identity', 'lookup-error'] as const) {
  test(`OAuth login leaves existing pool and metadata byte-identical on ${failure}`, async () => {
    const f = await fixture({
      resolveIdentity: async () => {
        if (failure === 'lookup-error')
          throw new Error('synthetic-login-secret-must-not-escape')
        return { deviceId: 'login-device', sessionId: 'login-session' }
      },
    })
    const before = await loginStoredBytes(f.paths)
    await expect(
      f.runtime.loginOAuth({
        routeId: 'main',
        credential: {
          access: 'sk-ant-oat01-login-successor',
          refresh: 'login-successor-refresh',
          expires: now + 18_000_000,
        },
      }),
    ).rejects.toThrow('Claude account identity could not be verified')
    expect(await loginStoredBytes(f.paths)).toEqual(before)
  })
}

test('OAuth login rechecks migration authority after delayed identity validation', async () => {
  const started = gate()
  const release = gate()
  const f = await fixture({
    resolveIdentity: async () => {
      started.open()
      await release.wait
      return {
        deviceId: 'login-device',
        sessionId: 'login-session',
        accountUuid: uuid,
      }
    },
  })
  const before = await loginStoredBytes(f.paths)
  const login = f.runtime.loginOAuth({
    routeId: 'main',
    credential: {
      access: 'sk-ant-oat01-login-successor',
      refresh: 'login-successor-refresh',
      expires: now + 18_000_000,
    },
  })
  const outcome = login.then(
    () => ({ status: 'resolved' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  )
  trackDetached(outcome)
  await started.wait
  await rm(f.paths.journal)
  release.open()
  const result = await outcome
  expect(result.status).toBe('rejected')
  if (result.status !== 'rejected')
    throw new Error('Revoked migration authority still allowed login')
  expect(result.error).toHaveProperty('code', 'migration-required')
  expect(await loginStoredBytes(f.paths)).toEqual(before)
})

test('enrollment rejects captured local metadata and Prime writes before reopening local recovery files', async () => {
  const f = await fixture()
  const prior = await f.runtime.authorizeLocal('main')
  if (prior.status !== 'usable')
    throw new Error('Local subject was not admitted')
  await writeFile(
    getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const files = [
    f.paths.config,
    f.paths.state,
    f.paths.runtime,
    f.paths.journal,
  ]
  for (const file of files)
    await writeFile(file, 'synthetic-unreadable-local-state', { mode: 0o600 })
  const before = await Promise.all(files.map((path) => readFile(path)))
  expect(
    await f.runtime.publishLocal(prior.subject, {
      quota: {
        accountIdentity: uuid,
        checkedAt: now,
        five_hour: { usedPercent: 99, remainingPercent: 1, checkedAt: now },
      },
    }),
  ).toBe(false)
  expect(await f.runtime.resetBackoff('main', prior.subject)).toBe(false)
  expect(
    await f.runtime.getOrCreateAuthLineage('main', prior.subject),
  ).toBeUndefined()
  expect(await f.runtime.incrementPrimeUsage('main', prior.subject)).toBe(false)
  expect(await Promise.all(files.map((path) => readFile(path)))).toEqual(before)
})

// A successful OAuth refresh can return an unusable access token. Preserve the
// replacement because the old refresh token was consumed, but refuse dispatch
// and require sign-in. This applies with or without a confirmed account UUID.
for (const unresolved of [false, true]) {
  test(`consumed unsupported OAuth successor is kept, refused without refresh backoff, and replaced by verified sign-in (${unresolved ? 'unresolved' : 'known'} account UUID)`, async () => {
    resetClaudeCodeIdentityCachesForTest()
    deferCleanup(() => resetClaudeCodeIdentityCachesForTest())
    const requests: string[] = []
    const http = spyOn(globalThis, 'fetch').mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input))
      requests.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`)
      if (url.href === TOKEN_URL)
        return Response.json({
          access_token: custodyTombstoneKey('anthropic'),
          refresh_token: 'synthetic-consumed-successor',
          expires_in: 3600,
        })
      if (url.pathname === '/api/claude_cli/bootstrap')
        return Response.json({ oauth_account: { account_uuid: uuid } })
      return new Response('{}', { status: 404 })
    }) as typeof fetch)
    deferCleanup(() => http.mockRestore())
    // Exercise the real OAuth exchange and bootstrap account-UUID validation.
    // The fetch mock supplies responses instead of contacting Anthropic.
    const f = await fixture(
      { refreshToken: undefined, resolveIdentity: undefined },
      unresolved,
    )
    const before = (await f.runtime.read()).accounts.find(
      (account) => account.id === 'main',
    )
    expect(before?.binding?.identity).toBe(unresolved ? undefined : uuid)

    const refreshed = await f.runtime.authorizeLocal('main', {
      intent: 'refresh',
    })
    expect(refreshed).toEqual({
      status: 'refused',
      reason: 'unsupported-access',
      persisted: true,
    })
    // Only the token POST runs; the unusable access token never reaches bootstrap.
    expect(requests).toEqual([`POST ${TOKEN_URL}`])

    const saved = await f.store.read()
    if (saved.status !== 'ready') throw new Error('Pool was not readable')
    const row = saved.rows.find((candidate) => candidate.id === 'imported-main')
    expect(row?.credential).toEqual({
      type: 'oauth',
      access: custodyTombstoneKey('anthropic'),
      refresh: 'synthetic-consumed-successor',
      expires: now + 3_600_000,
      // The store assigns this field when recording the refresh.
      lastRefreshedAt: expect.any(Number),
    })
    expect(row?.identity).toBe(unresolved ? undefined : uuid)
    expect(row?.enabled).toBe(true)

    const view = (await f.runtime.read()).accounts.find(
      (account) => account.id === 'main',
    )
    expect(view?.state).toBe('unsupported-access')
    expect(view?.lastRefreshError).toBeUndefined()
    const metadata = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
    if (metadata.status !== 'ready') throw new Error('Runtime was not readable')
    const entry = metadata.state.accounts['imported-main']
    expect(entry?.lastRefreshError).toBeUndefined()
    expect(entry?.validationRetry).toBeUndefined()
    expect(entry?.credentialValidation).toBeUndefined()

    for (const intent of ['serve', 'refresh'] as const)
      expect(await f.runtime.authorizeLocal('main', { intent })).toEqual({
        status: 'refused',
        reason: 'unsupported-access',
        persisted: false,
      })
    expect(requests).toEqual([`POST ${TOKEN_URL}`])

    await f.runtime.loginOAuth({
      routeId: 'main',
      credential: {
        access: 'sk-ant-oat01-synthetic-fresh-signin',
        refresh: 'synthetic-fresh-signin-refresh',
        expires: now + 18_000_000,
      },
    })
    const replaced = (await f.runtime.read()).accounts.find(
      (account) => account.id === 'main',
    )
    expect(replaced?.state).toBeUndefined()
    expect(replaced?.lastRefreshError).toBeUndefined()
    expect(replaced?.accountIdentity).toBe(uuid)
    const served = await f.runtime.authorizeLocal('main')
    if (served.status !== 'usable')
      throw new Error(`Fresh sign-in was not served: ${JSON.stringify(served)}`)
    expect(served.access).toBe('sk-ant-oat01-synthetic-fresh-signin')
    expect(served.binding.identity).toBe(uuid)
    // Sign-in verifies the new access with Claude's account lookup; nothing
    // else, and no further token exchange, is sent.
    const later = requests.slice(1)
    expect(
      later.filter((request) => request.endsWith('/api/claude_cli/bootstrap'))
        .length,
    ).toBeGreaterThan(0)
    expect(
      later.every((request) => request.endsWith('/api/claude_cli/bootstrap')),
    ).toBe(true)
  })
}

// A supported successor whose account lookup fails keeps the existing recovery
// path: the successor is saved, a validation retry is scheduled, and it is not
// served until a later lookup proves the account.
test('supported OAuth successor with a failed account lookup keeps validation recovery', async () => {
  let lookups = 0
  const f = await fixture({
    resolveIdentity: async () => {
      lookups++
      throw new Error('synthetic lookup outage')
    },
  })
  const refreshed = await f.runtime.authorizeLocal('main', {
    intent: 'refresh',
  })
  expect(refreshed).toMatchObject({ status: 'refused', persisted: true })
  expect(refreshed).not.toMatchObject({ reason: 'unsupported-access' })
  expect(lookups).toBe(1)
  const view = (await f.runtime.read()).accounts.find(
    (account) => account.id === 'main',
  )
  expect(view?.state).toBeUndefined()
  const metadata = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  if (metadata.status !== 'ready') throw new Error('Runtime was not readable')
  const entry = metadata.state.accounts['imported-main']
  expect(entry?.validationRetry?.nextRetryAt).toBeGreaterThan(now)
  expect(entry?.credentialValidation).toBeUndefined()
})

test('poll general exhaustion requires a depleted standard window, not missing or scoped-only quota', () => {
  const window = (remainingPercent: number) => ({
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    checkedAt: now,
  })
  expect(nativePollQuotaGenerallyExhausted({})).toBe(false)
  expect(nativePollQuotaGenerallyExhausted({ five_hour: window(0) })).toBe(true)
  expect(nativePollQuotaGenerallyExhausted({ seven_day: window(0) })).toBe(true)
  expect(nativePollQuotaGenerallyExhausted({ seven_day: window(-1) })).toBe(
    true,
  )
  expect(
    nativePollQuotaGenerallyExhausted({
      five_hour: window(1),
      seven_day: window(1),
    }),
  ).toBe(false)
  expect(
    nativePollQuotaGenerallyExhausted({
      scoped: [
        { ...window(0), id: 'model', title: 'Model', modelName: 'Model' },
      ],
    }),
  ).toBe(false)
})

test('poll overlay leaves committed headers alone without a matching pending poll', () => {
  const observations = new NativeQuotaObservations()
  const committed = {
    source: 'headers' as const,
    checkedAt: now,
    accountIdentity: uuid,
  }
  const storage = { version: 1 as const, accounts: [] }
  const overlay = () =>
    observations.quota('current', uuid, committed, storage, now)
  expect(overlay()).toBeUndefined()
  observations.set('main', {
    lineage: 'current',
    accountUuid: uuid,
    generalExhausted: false,
    entry: { quota: committed, checkedAt: now, refreshAfter: now },
  })
  expect(overlay()).toBeUndefined()
  observations.set('main', {
    lineage: 'replaced',
    accountUuid: uuid,
    generalExhausted: false,
    entry: {
      quota: { ...committed, source: 'poll' },
      checkedAt: now,
      refreshAfter: now,
    },
  })
  expect(overlay()).toBeUndefined()
})

test('a held header reading overlays routing before its save only when marked, and an older one never replaces a newer one', () => {
  const observations = new NativeQuotaObservations()
  const storage = { version: 1 as const, accounts: [] }
  const reading = (checkedAt: number, remainingPercent: number) => ({
    lineage: 'current',
    accountUuid: uuid,
    generalExhausted: remainingPercent <= 0,
    routeBeforeSave: true,
    entry: {
      quota: {
        source: 'headers' as const,
        checkedAt,
        accountIdentity: uuid,
        five_hour: {
          remainingPercent,
          usedPercent: 100 - remainingPercent,
          checkedAt,
        },
      },
      checkedAt,
      refreshAfter: checkedAt,
    },
  })
  const remaining = () =>
    observations.quota('current', uuid, undefined, storage, now + 1)?.quota
      .five_hour?.remainingPercent

  // OpenCode 1 header readings carry no flag and stay host-owned.
  const { routeBeforeSave: _unmarked, ...hostOwned } = reading(now, 40)
  expect(observations.hold('main', hostOwned)).toBe(true)
  expect(remaining()).toBeUndefined()

  const newer = reading(now + 1, 0)
  expect(observations.hold('main', newer)).toBe(true)
  expect(remaining()).toBe(0)
  const older = reading(now, 75)
  expect(observations.hold('main', older)).toBe(false)
  expect(remaining()).toBe(0)
  // Forgetting a stale reading leaves the newer held reading intact.
  observations.forget('main', older)
  expect(remaining()).toBe(0)
  // Another credential's reading is not applied to this one.
  expect(
    observations.quota('replaced', uuid, undefined, storage, now + 1),
  ).toBeUndefined()
  observations.forget('main', newer)
  expect(remaining()).toBeUndefined()
})

test('slow superseded poll publication cannot overwrite newer quota on disk', async () => {
  let clock = now
  const f = await fixture({ now: () => clock })
  const held = gate()
  const arrived = gate()
  const publish = f.runtime.publishLocal.bind(f.runtime)
  let first = true
  const delayed = spyOn(f.runtime, 'publishLocal').mockImplementation(
    async (subject, patch) => {
      if (patch.quota && first) {
        first = false
        arrived.open()
        await held.wait
      }
      return publish(subject, patch)
    },
  )
  deferCleanup(() => delayed.mockRestore())
  const transport: typeof fetch = Object.assign(
    async () =>
      Response.json({
        five_hour: {
          utilization: clock === now ? 10 : 98,
          resets_at: new Date(now + 3_600_000).toISOString(),
        },
      }),
    { preconnect: fetch.preconnect },
  )
  await f.runtime.fetchQuota('main', transport)
  await arrived.wait
  clock++
  await f.runtime.fetchQuota('main', transport)
  // Persist the newer reading while the older writer is still held outside its locks.
  const latest = f.runtime.quotaObservations.get('main')!
  const admission = await f.runtime.authorizeLocal('main')
  if (admission.status !== 'usable') throw new Error('Expected usable account')
  await publish(admission.subject, { quota: latest.entry.quota })
  // Accepted readings are coalesced; this separate handle sees only disk.
  const committedNewerQuota = async () => {
    const deadline = performance.now() + 1_000
    while (true) {
      const stored = await f.store.read()
      if (stored.status !== 'ready') throw new Error('Expected ready pool')
      const quota = stored.rows.find((row) => row.id === 'imported-main')?.quota
      if (quota && fromNativeQuotaMap(quota).five_hour?.checkedAt === now + 1)
        return stored
      if (performance.now() >= deadline)
        throw new Error(
          'Newer quota reading was not committed to disk within 1000 ms',
        )
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const before = await committedNewerQuota()
  expect(
    fromNativeQuotaMap(
      before.rows.find((row) => row.id === 'imported-main')?.quota,
    ).five_hour,
  ).toMatchObject({ checkedAt: now + 1, remainingPercent: 2 })
  held.open()
  await f.runtime.drainQuotaPublications()
  expect(
    (await f.runtime.read()).accounts[0]?.quota?.five_hour?.remainingPercent,
  ).toBe(2)
  // Draining publications does not wait for disk writes; close flushes the writer.
  await f.runtime.close()
  expect(await f.store.read()).toEqual(before)
})

for (const resetRefresh of [false, true]) {
  test(
    resetRefresh
      ? 'saved refresh still refuses a refresh-error reset during provider exchange'
      : 'saved refresh remains usable when a pending quota writer clears its error',
    async () => {
      const held = gate()
      const arrived = gate()
      let exchanges = 0
      const f = await fixture({
        refreshToken: async () => {
          exchanges++
          // Complete the real poll's pending writer after context capture, but
          // before the coordinator saves and validates the successor.
          held.open()
          await f.runtime.drainQuotaPublications()
          if (resetRefresh) {
            const subject = await f.runtime.captureLocalSubject('main')
            expect(
              await f.runtime.resetBackoff('main', subject, 'refresh'),
            ).toBe(true)
          }
          return {
            access: 'sk-ant-oat01-synthetic-successor',
            refresh: 'synthetic-new-refresh',
            expires: now + 4_000_000,
            expiresIn: 4000,
          }
        },
      })
      const publish = f.runtime.publishLocal.bind(f.runtime)
      const delayed = spyOn(f.runtime, 'publishLocal').mockImplementation(
        async (subject, patch) => {
          if (patch.quota) {
            arrived.open()
            await held.wait
          }
          return publish(subject, patch)
        },
      )
      deferCleanup(() => delayed.mockRestore())
      await f.runtime.fetchQuota(
        'main',
        Object.assign(async () => Response.json({}), {
          preconnect: fetch.preconnect,
        }),
      )
      await arrived.wait
      const before = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
      expect(
        before.status === 'ready' &&
          before.state.accounts['imported-main']?.quotaErrorClearedAt,
      ).toBeUndefined()
      const result = await f.runtime.authorizeLocal('main', {
        intent: 'refresh',
      })
      const pool = await f.store.read()
      const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
      if (pool.status !== 'ready' || saved.status !== 'ready')
        throw new Error('Missing saved refresh')
      const entry = saved.state.accounts['imported-main']!
      const row = pool.rows.find((row) => row.id === 'imported-main')!
      if (entry.binding.kind !== 'local')
        throw new Error('Expected local binding')
      expect(row.credential).toMatchObject({
        access: 'sk-ant-oat01-synthetic-successor',
        refresh: 'synthetic-new-refresh',
      })
      expect(entry.quotaErrorClearedAt).toBe(now)
      expect(entry.lastRefreshError).toBeUndefined()
      expect(entry.validationRetry).toBeUndefined()
      if (resetRefresh) {
        expect(result).toMatchObject({
          status: 'failed',
          persisted: true,
          reconciliationFailed: true,
        })
        expect(entry.refreshErrorClearedAt).toBe(now)
        expect(
          nativeLocalCredentialValidationMatches(
            entry.credentialValidation,
            entry.binding,
            row.credential,
          ),
        ).toBe(false)
      } else {
        expect(result).toMatchObject({
          status: 'usable',
          source: 'rotated',
          access: 'sk-ant-oat01-synthetic-successor',
        })
        expect(
          nativeLocalCredentialValidationMatches(
            entry.credentialValidation,
            entry.binding,
            row.credential,
          ),
        ).toBe(true)
      }
      // A refused publication must not poison the durable successor. The next
      // serve either uses its proof or validates it without another exchange.
      expect(await f.runtime.authorizeLocal('main')).toMatchObject({
        status: 'usable',
        access: 'sk-ant-oat01-synthetic-successor',
      })
      expect(exchanges).toBe(1)
    },
  )
}

test('refused poll publication drops only its own pending reading with a fixed warning', async () => {
  const f = await fixture()
  const held = gate()
  const arrived = gate()
  const records: LogTestRecord[] = []
  const level = getLogLevel()
  setLogLevel('warn')
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(level)
  })
  const refused = spyOn(f.runtime, 'publishLocal').mockImplementation(
    async () => {
      arrived.open()
      await held.wait
      throw new Error('synthetic-private-credential-and-exception')
    },
  )
  deferCleanup(() => refused.mockRestore())
  await f.runtime.fetchQuota(
    'main',
    Object.assign(async () => Response.json({}), {
      preconnect: fetch.preconnect,
    }),
  )
  await arrived.wait
  expect(f.runtime.quotaObservations.has('main')).toBe(true)
  held.open()
  await f.runtime.drainQuotaPublications()
  expect(f.runtime.quotaObservations.has('main')).toBe(false)
  expect(
    records.map(({ level, channel, message, payload }) => ({
      level,
      channel,
      message,
      payload,
    })),
  ).toEqual([
    {
      level: 'warn',
      channel: 'quota',
      message: 'Quota publication discarded',
      payload: undefined,
    },
  ])
})

test('pending poll quota cannot cross a replaced credential epoch', async () => {
  const f = await fixture()
  const held = gate()
  const arrived = gate()
  const publish = f.runtime.publishLocal.bind(f.runtime)
  const delayed = spyOn(f.runtime, 'publishLocal').mockImplementation(
    async (subject, patch) => {
      if (patch.quota) {
        arrived.open()
        await held.wait
      }
      return publish(subject, patch)
    },
  )
  deferCleanup(() => delayed.mockRestore())
  await f.runtime.fetchQuota(
    'main',
    Object.assign(
      async () =>
        Response.json({
          five_hour: {
            utilization: 98,
            resets_at: new Date(now + 3_600_000).toISOString(),
          },
        }),
      { preconnect: fetch.preconnect },
    ),
  )
  await arrived.wait
  expect(
    (await f.runtime.read()).accounts[0]?.quota?.five_hour?.remainingPercent,
  ).toBe(2)
  await f.runtime.putAccount({
    routeId: 'imported-main',
    replace: true,
    accountIdentity: uuid,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-replacement',
      refresh: 'replacement-refresh',
      expires: now + 3_600_000,
    },
  })
  expect((await f.runtime.read()).accounts[0]?.quota).toBeUndefined()
  held.open()
  await f.runtime.drainQuotaPublications()
  expect((await f.runtime.read()).accounts[0]?.quota).toBeUndefined()
})

test('a local view held after its selected pool read refuses a newly hosted marker', async () => {
  const f = await fixture()
  expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
  const before = await Promise.all(
    [f.paths.config, f.paths.state, f.paths.runtime].map((path) =>
      readFile(path),
    ),
  )
  const entered = gate()
  const release = gate()
  const original = filesystem.readFile
  let held = false
  const replacement = (async (...args: Parameters<typeof original>) => {
    const value = await original(...args)
    if (!held && String(args[0]) === f.paths.config) {
      held = true
      entered.open()
      await release.wait
    }
    return value
  }) as typeof original
  const spy = spyOn(filesystem, 'readFile').mockImplementation(replacement)
  deferCleanup(() => {
    release.open()
    spy.mockRestore()
    delete process.env.CORTEXKIT_VAULT_HOST
  })
  const pending = f.runtime.read()
  const settled = Promise.allSettled([pending])
  trackDetached(settled)
  try {
    await Promise.race([
      entered.wait,
      pending.then(() => {
        throw new Error('view returned before barrier')
      }),
    ])
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  } finally {
    release.open()
    spy.mockRestore()
  }
  expect((await settled)[0]).toMatchObject({
    status: 'rejected',
    reason: { code: 'route-unavailable' },
  })
  expect(
    await Promise.all(
      [f.paths.config, f.paths.state, f.paths.runtime].map((path) =>
        readFile(path),
      ),
    ),
  ).toEqual(before)
  expect(f.counts.refresh).toBe(0)
})

test('a usable local admission held at its final snapshot refuses a newly hosted marker', async () => {
  const f = await fixture()
  expect((await f.runtime.authorizeLocal('main')).status).toBe('usable')
  const entered = gate()
  const release = gate()
  const read = f.runtime.read.bind(f.runtime)
  let reads = 0
  const spy = spyOn(f.runtime, 'read').mockImplementation(async () => {
    const snapshot = await read()
    if (++reads === 2) {
      entered.open()
      await release.wait
    }
    return snapshot
  })
  deferCleanup(() => {
    release.open()
    spy.mockRestore()
    delete process.env.CORTEXKIT_VAULT_HOST
  })
  const before = await Promise.all(
    [f.paths.config, f.paths.state, f.paths.runtime].map((path) =>
      readFile(path),
    ),
  )
  const pending = f.runtime.authorizeLocal('main')
  const settled = Promise.allSettled([pending])
  trackDetached(settled)
  try {
    await Promise.race([
      entered.wait,
      pending.then(() => {
        throw new Error('admission returned before barrier')
      }),
    ])
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  } finally {
    release.open()
    spy.mockRestore()
  }
  expect((await settled)[0]).toMatchObject({
    status: 'rejected',
    reason: { code: 'route-unavailable' },
  })
  expect(
    await Promise.all(
      [f.paths.config, f.paths.state, f.paths.runtime].map((path) =>
        readFile(path),
      ),
    ),
  ).toEqual(before)
  expect(f.counts.refresh).toBe(0)
})

test('a refresh consumed before a hosted flip persists its successor but never serves or exchanges again', async () => {
  const entered = gate()
  const release = gate()
  let exchanges = 0
  let owned: ReturnType<typeof createNativeAccountRuntime> | undefined
  deferCleanup(() => {
    release.open()
    delete process.env.CORTEXKIT_VAULT_HOST
    owned?.close()
  })
  const f = await fixture({
    refreshToken: async () => {
      exchanges++
      entered.open()
      await release.wait
      return {
        access: 'sk-ant-oat01-synthetic-consumed',
        refresh: 'synthetic-consumed-successor',
        expires: now + 4_000_000,
        expiresIn: 4000,
      }
    },
  })
  owned = f.runtime
  await f.store.rotate('imported-main', {
    type: 'oauth',
    access: 'sk-ant-oat01-synthetic-expired',
    refresh: 'synthetic-predecessor',
    expires: now - 1,
  })
  const pending = f.runtime.authorizeLocal('main')
  const settled = Promise.allSettled([pending])
  trackDetached(settled)
  await Promise.race([
    entered.wait,
    pending.then(() => {
      throw new Error('admission returned before consuming its refresh token')
    }),
  ])
  const lookups = f.counts.lookups
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  release.open()
  const outcome = (await settled)[0]!
  if (outcome.status === 'fulfilled')
    expect(outcome.value.status).not.toBe('usable')
  else expect(outcome.reason).toMatchObject({ code: 'route-unavailable' })
  const loaded = await f.store.read()
  if (loaded.status !== 'ready')
    throw new Error('Pool unexpectedly unavailable')
  const row = loaded.rows.find((row) => row.id === 'imported-main')
  expect(row?.credential).toMatchObject({
    access: 'sk-ant-oat01-synthetic-consumed',
    refresh: 'synthetic-consumed-successor',
  })
  expect(f.counts.lookups).toBe(lookups)
  delete process.env.CORTEXKIT_VAULT_HOST
  await expect(f.runtime.authorizeLocal('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(exchanges).toBe(1)
})
