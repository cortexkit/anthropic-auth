import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  __setLogTestSink,
  captureNativeLocalPoolBinding,
  createNativeAccountRuntime,
  createNativePoolStore,
  fetchOAuthQuotaSnapshot,
  getLogLevel,
  getStickyRoutingStatePath,
  type LogTestRecord,
  type NativeAccountRuntime,
  type NativeCustodyClient,
  type NativePoolPaths,
  nativeAccountPolicy,
  type ProviderAccountUuid,
  quotaSnapshotPassesPolicy,
  readNativeAccountsForRequest,
  readNativeEnrollmentMode,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
  stickyRetryAfterWithJitter,
} from '@cortexkit/anthropic-auth-core'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import {
  type LimitSignal,
  type OpenCode2HookContext,
  placeholderSecret,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import { fingerprintOf } from '@cortexkit/common-auth/store'
import type { IntegrationOAuthMethodRegistration } from '@opencode/plugin/promise/integration'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths'
import { nativePoolStoreLocks } from '../../../core/src/pool-store'
import {
  holdRefreshJoin,
  observeRefreshJoin,
  refreshedJoinAccess,
  refreshJoinMessage,
} from '../../../core/src/tests/native-refresh-join-fixture.ts'
import {
  holdQuotaPublicationForRefresh,
  quotaRefreshAccess,
} from '../../../core/src/tests/native-refresh-quota-fixture.ts'
import { holdNativeRelayLock } from '../../../core/src/tests/native-relay-lock-fixture.ts'
import { requestLockProbe } from '../../../core/src/tests/native-request-lock-fixture.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { tokenFingerprint } from '../../../core/src/token-fingerprint'
import { ROUTING_HOLD_LIMIT_MS } from '../routing-relay'
import {
  CLAUDE_POOL_LOGIN_METHOD_ID,
  CLAUDE_VAULT_ACTIVATION_METHOD_ID,
} from '../v2/activation'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptContext,
  NativeAnthropicTransportRefusal,
} from '../v2/adapter'
import { installNativeAnthropic } from '../v2/install'
import { preparedAnthropicCredential } from '../v2/ownership'
import {
  claudeLoginMethods,
  LOCAL_LOGIN_REFUSED_IN_VAULT,
  nativeEnrollmentCallbacks,
  VAULT_ACTIVATION_REFUSED_LOCALLY,
} from '../v2/setup'
import {
  createNativeAnthropicSource,
  type NativeSourceProvenance,
} from '../v2/source'

const identity = '11111111-2222-4333-8444-555555555555'
const changedIdentity = '99999999-2222-4333-8444-555555555555'
const fallbackIdentity = '12345678-1234-4234-8234-123456789abc'
const scope = {
  phase: 'request' as const,
  providerID: 'anthropic',
  modelID: 'claude-sonnet-5',
  sessionID: 'ses_native_oc2',
  agent: 'build',
  kind: 'primary' as const,
}
const sameAccountInput = (limit: LimitSignal, input = scope) => ({
  ...input,
  accountId: 'main',
  limit,
  attempt: 1,
  error: { type: 'provider_error', message: 'provider refused the attempt' },
})
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
const cleanups: Array<() => Promise<void> | void> = []

test('Ultra fresh weekly-only poll passes policy and selects the local OpenCode 2 account', async () => {
  const fixture = await local()
  const credential = await fixture.runtime.authorizeLocal('main')
  if (credential.status !== 'usable')
    throw new Error('Missing local credential')
  const quota = await fetchOAuthQuotaSnapshot({
    accessToken: 'synthetic-ultra-access',
    fetchImpl: Object.assign(
      async () =>
        Response.json({ five_hour: null, seven_day: { utilization: 0 } }),
      { preconnect: fetch.preconnect },
    ),
  })
  await fixture.runtime.publishLocal(credential.subject, {
    quota: { ...quota, accountIdentity: identity },
  })
  await fixture.store.updateSettings((settings) => ({
    ...settings,
    quota: {
      enabled: true,
      // A zero floor permits 0%; use a positive weekly floor to prove quota refusal.
      minimumRemaining: { seven_day: 1 },
      failClosedOnUnknownQuota: true,
    },
  }))
  const snapshot = await fixture.runtime.read()
  const selected = await Promise.resolve(
    source(fixture.runtime, fixture.paths).chooseAccount(scope),
  ).catch((error: Error) => error.message)
  expect({
    passes: quotaSnapshotPassesPolicy(quota, snapshot.policyStorage),
    selected,
  }).toEqual({ passes: true, selected: 'main' })
  await fixture.runtime.publishLocal(credential.subject, {
    quota: {
      ...quota,
      accountIdentity: identity,
      seven_day: { ...quota.seven_day!, usedPercent: 100, remainingPercent: 0 },
    },
  })
  const exhausted = await fixture.runtime.read()
  expect(nativeAccountPolicy(exhausted.accounts[0]!, exhausted)).toMatchObject({
    status: 'blocked',
    reason: 'quota-ineligible',
    quotaPolicyLimits: ['quota-floor'],
  })
  expect(
    await source(fixture.runtime, fixture.paths).chooseAccount(scope),
  ).toBeUndefined()
  await fixture.runtime.addApi({
    routeId: 'paid-ultra',
    apiKey: 'synthetic-ultra-api-key',
    baseURL: 'https://api-route.invalid',
    authHeader: 'x-api-key',
  })
  expect(
    await source(fixture.runtime, fixture.paths).chooseAccount(scope),
  ).toBe('paid-ultra')
  await fixture.runtime.publishLocal(credential.subject, {
    quota: {
      ...quota,
      accountIdentity: identity,
      scoped: [
        {
          id: 'fable',
          title: 'Fable only',
          modelId: 'claude-fable-5-1',
          modelName: 'Fable',
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: quota.checkedAt!,
        },
      ],
    },
  })
  expect(
    await source(fixture.runtime, fixture.paths).chooseAccount({
      ...scope,
      modelID: 'claude-fable-5-1',
    }),
  ).toBeUndefined()
})

test('Ultra unknown local quota still refuses OpenCode 2 under fail-closed', async () => {
  const fixture = await local()
  await fixture.store.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: true, failClosedOnUnknownQuota: true },
  }))
  const poll = spyOn(fixture.runtime, 'fetchQuota').mockRejectedValue(
    new Error('No reading'),
  )
  try {
    expect(
      await source(fixture.runtime, fixture.paths).chooseAccount(scope),
    ).toBeUndefined()
  } finally {
    poll.mockRestore()
  }
})

test('Ultra paid API authorization still requires a fresh weekly reading', async () => {
  const fixture = await local()
  await fixture.runtime.addApi({
    routeId: 'paid-ultra',
    apiKey: 'synthetic-ultra-api-key',
    baseURL: 'https://api-route.invalid',
    authHeader: 'x-api-key',
  })
  const credential = await fixture.runtime.authorizeLocal('main')
  if (credential.status !== 'usable')
    throw new Error('Missing local credential')
  const now = Date.now()
  const quota = {
    source: 'poll' as const,
    accountIdentity: identity,
    checkedAt: now - 301_000,
    seven_day: {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now - 301_000,
    },
  }
  await fixture.runtime.publishLocal(credential.subject, { quota })
  const native = source(fixture.runtime, fixture.paths)
  expect(await native.authorizeAccount(scope, 'paid-ultra')).toBeUndefined()
  await fixture.runtime.publishLocal(credential.subject, {
    quota: {
      ...quota,
      checkedAt: now,
      seven_day: { ...quota.seven_day, checkedAt: now },
    },
  })
  expect((await native.authorizeAccount(scope, 'paid-ultra'))?.route).toBe(
    'api',
  )
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('OC2 shared routing relay', () => {
  function bridge(
    accountFor: () => unknown,
    report: (value: unknown) => unknown = () => {},
  ) {
    const globals = globalThis as Record<symbol, unknown>
    const key = Symbol.for('cortexkit.routing')
    globals[key] = () => ({ accountFor: async () => accountFor(), report })
    cleanups.push(() => {
      delete globals[key]
    })
  }

  test('accepts a late-installed answer, moves an existing pin and stays pinned without advice', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const snapshot = await f.runtime.read()
    const fallback = snapshot.accounts.find(
      (row) => row.accountIdentity === fallbackIdentity,
    )!
    let answer: unknown = {
      account_id: fallbackIdentity,
      credential_id: fallback.credentialId,
    }
    bridge(() => answer)
    expect(await native.chooseAccount(scope)).toBe(fallback.id)
    await native.drainRoutingPublications()
    expect(
      rawPin(await readFile(snapshot.routingPath!, 'utf8'), scope.sessionID),
    ).toContain(fallbackIdentity)
    answer = null
    expect(await native.chooseAccount(scope)).toBe(fallback.id)
  })

  test.each(['null', 'unknown', 'wrong credential'])(
    '%s answer preserves the local choice',
    async (mode) => {
      const f = await vaultWithFallback()
      const native = source(f.runtime, f.paths)
      bridge(() =>
        mode === 'null'
          ? null
          : {
              account_id: mode === 'unknown' ? 'unknown' : fallbackIdentity,
              credential_id: 'wrong',
            },
      )
      expect(await native.chooseAccount(scope)).toBe('main')
    },
  )

  test('a retry asks routing again and a capped same-account hold keeps the pin', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    let calls = 0
    bridge(() => {
      calls++
      return {
        account_id: identity,
        credential_id: 'oauth:anthropic',
        hold: { retry_after_ms: 9_000_000 },
      }
    })
    // The host can wait only when retrying a refused account, not before an initial send.
    expect(await native.chooseAccount(scope)).toBe('main')
    const before = await f.runtime.read()
    await native.drainRoutingPublications()
    const pin = rawPin(
      await readFile(before.routingPath!, 'utf8'),
      scope.sessionID,
    )
    expect(
      await native.chooseAccount({
        ...scope,
        phase: 'retry',
        rerouteFrom: {
          accountId: 'main',
          limit: { reason: 'provider-429', status: 429 },
        },
      }),
    ).toEqual({ hold: { delayMs: ROUTING_HOLD_LIMIT_MS } })
    await native.drainRoutingPublications()
    expect(
      rawPin(await readFile(before.routingPath!, 'utf8'), scope.sessionID),
    ).toBe(pin)
    expect(calls).toBe(2)
  })

  test('a hold naming another account cannot hold or move the refused account', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    await native.chooseAccount(scope)
    bridge(() => ({
      account_id: identity,
      credential_id: 'oauth:anthropic',
      hold: { retry_after_ms: 100 },
    }))
    const choice = await native.chooseAccount({
      ...scope,
      phase: 'retry',
      rerouteFrom: {
        accountId: 'main',
        limit: { reason: 'provider-403', status: 403 },
      },
    })
    expect(choice).toEqual({ hold: { delayMs: 100 } })
    bridge(() => ({
      account_id: fallbackIdentity,
      credential_id: 'oauth:anthropic:work',
      hold: { retry_after_ms: 100 },
    }))
    expect(
      typeof (await native.chooseAccount({
        ...scope,
        phase: 'retry',
        rerouteFrom: {
          accountId: 'main',
          limit: { reason: 'provider-403', status: 403 },
        },
      })),
    ).toBe('string')
  })

  test('reports the actual serving account once with safe headers even if report throws', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    const reports: any[] = []
    bridge(
      () => null,
      (report) => {
        reports.push(report)
        throw new Error('bridge unavailable')
      },
    )
    await native.chooseAccount(scope)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('No authorization')
    const headers = new Headers({
      'Anthropic-RateLimit-New-Header': 'kept',
      'request-id': 'discarded',
    })
    native.quotaFromHeaders?.(headers, {
      ...context(auth.provenance),
      status: 200,
    })
    native.quotaFromHeaders?.(headers, {
      ...context(auth.provenance),
      status: 200,
    })
    await Promise.resolve()
    expect(reports).toEqual([
      {
        account_id: identity,
        credential_id: 'oauth:anthropic',
        outcome: 'served',
        headers: { 'anthropic-ratelimit-new-header': 'kept' },
      },
    ])
  })

  test('served raw utilization 0.996 reports served without exhausted', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    const reports: unknown[] = []
    bridge(
      () => null,
      (report) => reports.push(report),
    )
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('No authorization')
    native.quotaFromHeaders?.(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.996',
      }),
      { ...context(auth.provenance), status: 200 },
    )
    await Promise.resolve()
    expect(reports).toEqual([
      {
        account_id: identity,
        credential_id: 'oauth:anthropic',
        outcome: 'served',
        headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.996' },
      },
    ])
  })

  test.each([undefined, 'Claude-Fable-Pool'])(
    'Fable 429 reports the persisted usage-poll pool %s on OpenCode 2',
    async (modelId) => {
      const f = await vaultWithFallback()
      const quota = await fetchOAuthQuotaSnapshot({
        accessToken: 'synthetic-access',
        fetchImpl: Object.assign(
          async () =>
            Response.json({
              limits: [
                {
                  kind: 'weekly_scoped',
                  group: 'weekly',
                  percent: 20,
                  scope: {
                    model: {
                      display_name: ' Fable ',
                      ...(modelId ? { id: modelId } : {}),
                    },
                  },
                },
              ],
            }),
          { preconnect: fetch.preconnect },
        ),
      })
      const receipt = await f.runtime.authorizeVault('main')
      await f.runtime.vault.publish(receipt, {
        quota: { ...quota, accountIdentity: identity },
      })
      const native = source(f.runtime, f.paths)
      const reports: unknown[] = []
      const reported = Promise.withResolvers<void>()
      bridge(
        () => null,
        (report) => {
          reports.push(report)
          reported.resolve()
        },
      )
      const fable = { ...scope, modelID: 'claude-fable-5' }
      const auth = await native.authorizeAccount(fable, 'main')
      if (!auth) throw new Error('No authorization')
      native.quotaFromHeaders?.(
        new Headers({
          'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
        }),
        { ...context(auth.provenance), modelID: fable.modelID, status: 429 },
      )
      await reported.promise
      expect(reports).toEqual([
        {
          account_id: identity,
          credential_id: 'oauth:anthropic',
          outcome: 'exhausted',
          window: '7d',
          pool: (modelId ?? 'Fable').toLowerCase(),
        },
      ])
    },
  )

  test('429 reports only its own exhausted 7d window, never a stored 5h reading', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    const reports: unknown[] = []
    bridge(
      () => null,
      (report) => reports.push(report),
    )
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('No authorization')
    native.quotaFromHeaders?.(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '1',
      }),
      { ...context(auth.provenance), status: 200 },
    )
    await Promise.resolve()
    reports.length = 0
    native.quotaFromHeaders?.(
      new Headers({
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-reset': '2000000000',
      }),
      { ...context(auth.provenance), status: 429 },
    )
    await Promise.resolve()
    expect(reports).toEqual([
      {
        account_id: identity,
        credential_id: 'oauth:anthropic',
        outcome: 'exhausted',
        window: '7d',
        resets_at: 2_000_000_000_000,
      },
    ])
  })

  test.each([true, false])(
    'stream rate limit uses its response headers once (confirmed=%s)',
    async (confirmed) => {
      const f = await vaultWithFallback()
      const native = source(f.runtime, f.paths)
      const reports: unknown[] = []
      bridge(
        () => null,
        (report) => reports.push(report),
      )
      const auth = await native.authorizeAccount(scope, 'main')
      if (!auth) throw new Error('No authorization')
      const input = context(auth.provenance)
      native.quotaFromHeaders?.(
        new Headers(
          confirmed
            ? {
                'anthropic-ratelimit-unified-5h-status': 'rejected',
                'anthropic-ratelimit-unified-5h-utilization': '0.996',
                'anthropic-ratelimit-unified-5h-reset': '2000000000',
              }
            : {},
        ),
        { ...input, status: 200 },
      )
      await Promise.resolve()
      reports.length = 0
      native.limitFromStreamError?.({
        ...input,
        errorType: 'rate_limit_error',
        message: 'limited',
      })
      native.limitFromStreamError?.({
        ...input,
        errorType: 'rate_limit_error',
        message: 'limited',
      })
      native.limitFromHostError?.(
        { type: 'rate_limit_error', message: 'limited', status: 429 },
        input,
      )
      await Promise.resolve()
      expect(reports).toEqual([
        {
          account_id: identity,
          credential_id: 'oauth:anthropic',
          outcome: 'exhausted',
          window: confirmed ? '5h' : '7d',
          ...(confirmed ? { resets_at: 2_000_000_000_000 } : {}),
        },
      ])
    },
  )

  test.each(['floor', 'reserve', 'disabled', 'model scope'])(
    'overrides advice refused by %s',
    async (mode) => {
      const f = await vaultWithFallback()
      const originalRead = f.runtime.read
      const now = Date.now()
      const quota = (remaining: number, fable: number) => ({
        checkedAt: now,
        five_hour: {
          usedPercent: 100 - remaining,
          remainingPercent: remaining,
          checkedAt: now,
        },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: now },
        scoped: [
          {
            id: 'fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 100 - fable,
            remainingPercent: fable,
            checkedAt: now,
          },
        ],
      })
      const runtime: NativeAccountRuntime = {
        ...f.runtime,
        read: async () => {
          const snapshot = await originalRead()
          return {
            ...snapshot,
            policyStorage: {
              ...snapshot.policyStorage,
              ...(mode === 'floor'
                ? { killswitch: { enabled: true, main: { five_hour: 20 } } }
                : {}),
            },
            accounts: snapshot.accounts.map((row) => ({
              ...row,
              ...(mode === 'disabled' && row.id !== 'main'
                ? { enabled: false }
                : {}),
              quota:
                row.id === 'main'
                  ? quota(100, mode === 'reserve' ? 0 : 100)
                  : quota(
                      mode === 'floor' ? 10 : 100,
                      mode === 'model scope' ? 0 : 100,
                    ),
            })),
          }
        },
      }
      const native = source(runtime, f.paths)
      bridge(() => ({
        account_id: fallbackIdentity,
        credential_id: 'oauth:anthropic:work',
        ...(mode === 'floor' ? { hold: { retry_after_ms: 100 } } : {}),
      }))
      expect(
        await native.chooseAccount({
          ...scope,
          modelID:
            mode === 'reserve'
              ? 'claude-opus-4-8'
              : mode === 'model scope'
                ? 'claude-fable-5'
                : scope.modelID,
        }),
      ).toBe('main')
    },
  )

  test('a slow relay falls back to our account choice', async () => {
    const f = await vaultWithFallback()
    const native = source(f.runtime, f.paths)
    bridge(() => new Promise(() => {}))
    expect(await native.chooseAccount(scope)).toBe('main')
  })

  test('same-account credential recovery never asks routing', async () => {
    const f = await vault()
    const native = source(f.runtime, f.paths)
    let calls = 0
    bridge(() => {
      calls++
      return null
    })
    expect(await native.chooseAccount(scope)).toBe('main')
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('No authorization')
    const limit = await native.limitFromResponse?.({
      ...context(auth.provenance),
      status: 401,
      headers: new Headers(),
      body: async () => '',
    })
    if (!limit) throw new Error('No newer credential recovery')
    expect(await native.retrySameAccount?.(sameAccountInput(limit))).toEqual({
      accountId: 'main',
    })
    expect(calls).toBe(1)
  })
})
const usageTests = createTestLifetimeSuite()

usageTests.test(
  'OC2 header bookkeeping never delays attempt end or independent lastUsed under a held pool lock',
  async () => {
    const owned: Array<() => Promise<void> | void> = []
    usageTests.deferCleanup(async () => {
      for (const cleanup of owned.reverse()) await cleanup()
    })
    const fixture = await local(undefined, owned)
    const native = source(fixture.runtime, fixture.paths, owned)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('Missing local authorization')
    const lease = await acquireRefreshFileLock({
      ...nativePoolStoreLocks(fixture.paths)[0],
      ttlMs: 60_000,
      renew: true,
    })
    if (!lease) throw new Error('Pool fixture lock unavailable')
    owned.push(() => lease.release())
    const start = Date.now()
    native.quotaFromHeaders?.(
      new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.25' }),
      { ...context(auth.provenance), status: 200 },
    )
    let ended = false
    const end = Promise.resolve(
      native.onAttemptEnd!(context(auth.provenance), {
        status: 200,
        outputStarted: true,
      }),
    ).then(() => {
      ended = true
    })
    usageTests.trackDetached(end)
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(ended).toBe(true)
      expect(
        (await fixture.runtime.read()).accounts[0]?.lastUsed,
      ).toBeGreaterThanOrEqual(start)
      await lease.assertOwned()
    } finally {
      await lease.release()
    }
    await end
    await native.close()
    expect(
      (await fixture.runtime.read()).accounts[0]?.quota?.five_hour
        ?.remainingPercent,
    ).toBe(75)
  },
)

for (const concurrency of [4, 8]) {
  usageTests.test(
    `OC2 concurrent local sends retain quota and lastUsed N=${concurrency}`,
    async () => {
      const owned: Array<() => Promise<void> | void> = []
      usageTests.deferCleanup(async () => {
        for (const cleanup of owned.reverse()) await cleanup()
      })
      const locks: string[] = []
      const fixture = await local(
        {
          onLockEvent: (event) => {
            if (event.type === 'acquired') locks.push(event.name)
          },
        },
        owned,
      )
      const native = source(fixture.runtime, fixture.paths, owned)
      const authorizations = await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          native.authorizeAccount(
            { ...scope, sessionID: `parallel-${index}` },
            'main',
          ),
        ),
      )
      const records: LogTestRecord[] = []
      const previous = getLogLevel()
      setLogLevel('debug')
      __setLogTestSink((record) => records.push(record))
      owned.push(() => {
        __setLogTestSink(null)
        setLogLevel(previous)
      })
      locks.length = 0
      const start = Date.now()
      await Promise.all(
        authorizations.map(async (auth, index) => {
          if (!auth) throw new Error('Missing local send authorization')
          const input = context(auth.provenance, `parallel-${index}`)
          native.quotaFromHeaders?.(
            new Headers({
              'anthropic-ratelimit-unified-5h-utilization': '0.25',
              'anthropic-ratelimit-unified-7d-utilization': '0.4',
            }),
            { ...input, status: 200 },
          )
          await native.onAttemptEnd?.(input, {
            status: 200,
            outputStarted: true,
          })
        }),
      )
      await native.close()
      const account = (await fixture.runtime.read()).accounts[0]!
      const dropped = records.filter(
        (record) =>
          record.message === 'Account usage publication unavailable' ||
          record.message === 'Quota publication discarded',
      ).length
      const contention = records.filter((record) =>
        JSON.stringify(record.payload ?? {}).includes('LockContentionError'),
      ).length
      console.log(
        `local OC2 N=${concurrency}: dropped=${dropped} LockContentionError=${contention} pool-config=${locks.filter((name) => name === 'pool-config').length} native-runtime=${locks.filter((name) => name === 'native-runtime').length}`,
      )
      expect(dropped).toBe(0)
      expect(contention).toBe(0)
      expect(account.quota?.five_hour?.remainingPercent).toBe(75)
      expect(account.lastUsed).toBeGreaterThanOrEqual(start)
      expect(
        locks.filter((name) => name === 'pool-config').length,
      ).toBeLessThan(concurrency)
    },
  )
}

usageTests.test(
  'OC2 attempt-end lastUsed refusal is detached and drained without rejecting the completed attempt',
  async () => {
    const owned: Array<() => Promise<void> | void> = []
    usageTests.deferCleanup(async () => {
      for (const cleanup of owned.reverse()) await cleanup()
    })
    const fixture = await local(undefined, owned)
    const native = source(fixture.runtime, fixture.paths, owned)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('Native authorization refused')
    const entered = usageTests.gate()
    const release = usageTests.gate()
    const records: LogTestRecord[] = []
    const previous = getLogLevel()
    setLogLevel('debug')
    __setLogTestSink((record) => records.push(record))
    owned.push(() => {
      __setLogTestSink(null)
      setLogLevel(previous)
    })
    const publication = spyOn(
      fixture.runtime,
      'publishLocal',
    ).mockImplementation(async () => {
      entered.open()
      await release.wait
      throw Object.assign(new Error('/private/secret'), {
        name: 'NativeRuntimeError',
        code: 'publication-refused',
      })
    })
    owned.push(() => publication.mockRestore())
    await native.onAttemptEnd?.(context(auth.provenance), {
      status: 200,
      outputStarted: true,
    })
    await entered.wait
    let closed = false
    const closing = native.close().then(() => {
      closed = true
    })
    usageTests.trackDetached(closing)
    await Promise.resolve()
    expect(closed).toBe(false)
    release.open()
    await closing
    expect(
      records.filter(
        (record) => record.message === 'Account usage publication unavailable',
      ),
    ).toMatchObject([
      {
        level: 'error',
        payload: { name: 'NativeRuntimeError', code: 'publication-refused' },
      },
    ])
  },
)

usageTests.test(
  'OC2 inconsistent relay pair refuses locally before dispatch authorization',
  async () => {
    const owned: Array<() => Promise<void> | void> = []
    usageTests.deferCleanup(async () => {
      for (const cleanup of owned.reverse()) await cleanup()
    })
    const fixture = await local(undefined, owned)
    await fixture.runtime.updateRelay({
      enabled: true,
      url: 'https://never-send.invalid',
      token: 'synthetic-never-send-token',
    })
    await fixture.store.updateSettings((settings) => {
      ;(settings.relay as Record<string, unknown>).generation = 'mismatched'
    })
    const native = source(fixture.runtime, fixture.paths, owned)
    await expect(native.authorizeAccount(scope, 'main')).rejects.toMatchObject({
      code: 'relay-inconsistent',
      status: 400,
      retryable: false,
      message:
        'request refused: relay configuration is inconsistent; no request was sent',
    })
  },
)

usageTests.test(
  'OC2 saved refresh serves the successor across a pending quota publication',
  async () => {
    const owned: Array<() => Promise<void> | void> = []
    usageTests.deferCleanup(async () => {
      for (const cleanup of owned.reverse()) await cleanup()
    })
    const held = holdQuotaPublicationForRefresh(usageTests)
    const fixture = await local(
      {
        refreshToken: held.refreshToken,
        resolveIdentity: async () => ({
          accountUuid: identity as ProviderAccountUuid,
          deviceId: 'fixture',
          sessionId: 'fixture',
        }),
      },
      owned,
    )
    const native = source(fixture.runtime, fixture.paths, owned)
    const first = await native.authorizeAccount(scope, 'main')
    if (first?.route !== 'oauth') throw new Error('Missing first authorization')
    await held.poll(fixture.runtime)
    const limit = await native.limitFromResponse!({
      ...context(first.provenance),
      status: 401,
      headers: new Headers(),
      body: async () => '',
    })
    expect(limit).toMatchObject({ status: 401 })
    if (!limit) throw new Error('Missing retry limit')
    await native.retrySameAccount?.(sameAccountInput(limit))
    expect(await native.authorizeAccount(scope, 'main')).toMatchObject({
      accessToken: quotaRefreshAccess,
    })
    expect(held.exchanges()).toBe(1)
    expect(await fixture.runtime.authorizeLocal('main')).toMatchObject({
      status: 'usable',
      source: 'current',
      access: quotaRefreshAccess,
    })
  },
)

for (const scenario of ['proactive', '401', 'deadline'] as const) {
  usageTests.test(
    `OC2 refresh join ${scenario} preserves valid-token admission`,
    async () => {
      const owned: Array<() => Promise<void> | void> = []
      usageTests.deferCleanup(async () => {
        for (const cleanup of owned.reverse()) await cleanup()
      })
      const held = holdRefreshJoin(usageTests)
      const probe = requestLockProbe()
      const fixture = await local(
        {
          onLockEvent: probe.onLockEvent,
          refreshToken: held.refreshToken,
          resolveIdentity: async () => ({
            accountUuid: identity as ProviderAccountUuid,
            deviceId: 'fixture',
            sessionId: 'fixture',
          }),
        },
        owned,
      )
      const native = source(fixture.runtime, fixture.paths, owned)
      const first = await native.authorizeAccount(scope, 'main')
      if (first?.route !== 'oauth')
        throw new Error('Missing first authorization')
      expect(first.accessToken).toBe('sk-ant-oat01-native-only')
      const owner = Promise.resolve(
        scenario === 'proactive'
          ? fixture.runtime.authorizeLocal('main', { intent: 'refresh' })
          : native.limitFromResponse!({
              ...context(first.provenance),
              status: 401,
              headers: new Headers(),
              body: async () => '',
            }),
      )
      void owner.catch(() => {})
      let waiting:
        | Promise<Awaited<ReturnType<typeof native.authorizeAccount>>>
        | undefined
      try {
        await held.entered
        probe.begin()
        waiting = Promise.resolve(
          native.authorizeAccount(
            { ...scope, sessionID: 'join-waiter' },
            'main',
          ),
        ).then((auth) => {
          probe.dispatch()
          return auth
        })
        if (scenario === 'proactive') {
          expect(await observeRefreshJoin(waiting)).toMatchObject({
            status: 'fulfilled',
            value: { accessToken: first.accessToken },
          })
          expect(held.completed()).toBe(false)
          expect(probe.foreground).toEqual([])
        } else if (scenario === '401') {
          expect((await observeRefreshJoin(waiting, 100)).status).toBe(
            'pending',
          )
          held.release()
          expect(await waiting).toMatchObject({
            accessToken: refreshedJoinAccess,
          })
          const limit = await owner
          expect(limit).toMatchObject({ status: 401 })
          if (
            !limit ||
            typeof limit.status !== 'number' ||
            !('reason' in limit)
          )
            throw new Error('Missing 401 retry')
          await native.retrySameAccount?.(sameAccountInput(limit))
          expect(await native.authorizeAccount(scope, 'main')).toMatchObject({
            accessToken: refreshedJoinAccess,
          })
        } else {
          expect(await observeRefreshJoin(waiting, 3_500)).toMatchObject({
            status: 'rejected',
            error: { message: refreshJoinMessage, code: 'ECONNRESET' },
          })
          expect(held.completed()).toBe(false)
          expect(probe.afterDispatch).toEqual([])
        }
      } finally {
        held.release()
        await Promise.allSettled([owner, ...(waiting ? [waiting] : [])])
      }
    },
  )
}

for (const scenario of ['local-healthy', 'vault-healthy', 'refresh'] as const) {
  usageTests.test(
    `OC2 ${scenario} request observes only required foreground locks`,
    async () => {
      const owned: Array<() => Promise<void> | void> = []
      usageTests.deferCleanup(async () => {
        for (const cleanup of owned.reverse()) await cleanup()
      })
      const probe = requestLockProbe()
      const now = () => Date.now() + 2 * 3600_000
      const fixture =
        scenario === 'vault-healthy'
          ? await vault(
              [7],
              () => identity,
              { mode: 'sticky-balanced' },
              probe.onLockEvent,
            )
          : await local(
              {
                onLockEvent: probe.onLockEvent,
                ...(scenario === 'refresh'
                  ? {
                      now,
                      refreshToken: async () => ({
                        access: 'sk-ant-oat01-refreshed-control',
                        refresh: 'synthetic-control-refresh',
                        expires: now() + 3600_000,
                        expiresIn: 3600,
                      }),
                      resolveIdentity: async () => ({
                        accountUuid: identity as ProviderAccountUuid,
                        deviceId: 'fixture',
                        sessionId: 'fixture',
                      }),
                    }
                  : {}),
              },
              owned,
            )
      await fixture.runtime.updateSettings((settings) => {
        settings.routing = { mode: 'sticky-balanced' }
      })
      const native = source(fixture.runtime, fixture.paths, owned)
      probe.begin()
      expect(await native.chooseAccount(scope)).toBe('main')
      const auth = await native.authorizeAccount(scope, 'main')
      expect(auth).toBeDefined()
      if (!auth) return
      probe.dispatch()
      if (scenario === 'refresh')
        expect(
          probe.foreground.some(
            (event) =>
              event.name.startsWith('native-account-provider-') &&
              event.path === fixture.paths.state,
          ),
        ).toBe(true)
      else expect(probe.foreground).toEqual([])
      await native.onAttemptEnd?.(context(auth.provenance), {
        status: 200,
        outputStarted: true,
      })
      await native.close()
      expect(probe.detached.some((event) => event.name === 'write')).toBe(true)
      expect(probe.afterDispatch.length).toBeGreaterThan(0)
      expect(
        probe.afterDispatch.some((event) => event.name === 'native-runtime'),
      ).toBe(true)
      // Vault bookkeeping after the reply writes runtime state under its own
      // lock only; it must never take the shared roster lock, which other
      // processes need for quota readings and discovery.
      if (scenario === 'vault-healthy')
        expect(
          probe.afterDispatch.some(
            (event) => event.name === 'claustrum-roster-write',
          ),
        ).toBe(false)
    },
  )
}

for (const configured of [false, true]) {
  usageTests.test(
    `OC2 request ignores held native-relay lock (${configured ? 'relay' : 'direct'})`,
    async () => {
      const owned: Array<() => Promise<void> | void> = []
      usageTests.deferCleanup(async () => {
        for (const cleanup of owned.reverse()) await cleanup()
      })
      const fixture = await local(undefined, owned)
      if (configured)
        await fixture.runtime.updateRelay({
          enabled: true,
          url: 'https://held-relay.invalid',
          token: 'synthetic-held-relay-token',
          transport: 'http',
          fallbackToDirect: false,
        })
      const native = source(fixture.runtime, fixture.paths, owned)
      const held = await holdNativeRelayLock(fixture.paths.config, usageTests)
      try {
        const account = await native.chooseAccount(scope)
        expect(account).toBe('main')
        const auth = await native.authorizeAccount(scope, 'main')
        if (!auth) throw new Error('Native authorization refused')
        expect(auth.dispatch).toEqual(
          configured
            ? {
                kind: 'http-relay',
                url: 'https://held-relay.invalid',
                token: 'synthetic-held-relay-token',
              }
            : { kind: 'direct' },
        )
        expect(await fixture.runtime.getRelayConfig()).toEqual(
          configured
            ? {
                enabled: true,
                url: 'https://held-relay.invalid',
                token: 'synthetic-held-relay-token',
                transport: 'http',
                fallbackToDirect: false,
              }
            : null,
        )
        await held.assertOwned()
      } finally {
        await held.pastTimeout
        await held.release()
      }
    },
    25_000,
  )
}

async function storage(owned = cleanups) {
  const parent = resolve(
    import.meta.dir,
    '../../../../node_modules/.cache/opencode2-native-source',
  )
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'fixture-'))
  owned.push(() => rm(directory, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(directory, 'anthropic-auth.json'),
    join(directory, 'anthropic-auth-state.json'),
  )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({ version: 1, accounts: [] }),
    { mode: 0o600 },
  )
  await writeFile(
    paths.legacyState,
    JSON.stringify({ version: 1, accounts: {} }),
    { mode: 0o600 },
  )
  await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath: join(directory, 'auth.json'),
    routingSourcePath: join(directory, 'legacy-routing.json'),
    routingDestinationPath: join(directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  // The account runtime serves vault accounts only when this OpenCode's vault
  // enrollment file exists, regardless of account settings. Give each fixture
  // its own enrollment file path inside its directory, so the tests never read
  // an enrollment file on the machine running them.
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      directory,
      'opencode-enrollment.json',
    ),
  }
  return { paths, store, env }
}
async function local(
  localOptions?: Parameters<typeof createNativeAccountRuntime>[0]['local'],
  owned = cleanups,
) {
  const { paths, store, env } = await storage(owned)
  await store.add({
    id: 'primary-row',
    identity,
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-native-only',
      refresh: 'native-only-refresh',
      expires: Date.now() + 3600_000,
    },
  })
  await store.updateSettings(() => ({
    mainAccountId: 'primary-row',
    quota: { enabled: false },
    routing: { mode: 'main-first' },
  }))
  const read = await store.read()
  const row = read.status === 'ready' ? read.rows[0] : undefined
  if (
    row?.credential?.type !== 'oauth' ||
    !row.credential.access ||
    row.credential.expires === undefined
  )
    throw new Error('Missing native seed')
  const binding = captureNativeLocalPoolBinding(paths, row)
  await writeFile(
    paths.runtime,
    JSON.stringify({
      version: 1,
      storageId: paths.storageId,
      accounts: {
        'primary-row': {
          binding,
          credentialValidation: {
            binding,
            credentialFingerprint: fingerprintOf(row.credential),
            version: {
              accessFingerprint: tokenFingerprint(row.credential.access),
              expires: row.credential.expires,
              ...(Object.hasOwn(row.credential, 'lastRefreshedAt')
                ? { lastRefreshedAt: row.credential.lastRefreshedAt }
                : {}),
            },
          },
        },
      },
    }),
    { mode: 0o600 },
  )
  // Invalid legacy JSON cannot supply credentials, so a request must use the
  // validated login in migrated storage.
  await writeFile(paths.legacyConfig, '{invalid-legacy-config')
  await writeFile(paths.legacyState, '{invalid-legacy-credential-state')
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: localOptions,
    vault: { env },
  })
  owned.push(() => runtime.close())
  return { paths, runtime, store, env }
}
/**
 * Registers the login methods built by claudeLoginMethods through common-auth,
 * as plugin setup does, and returns the registration OpenCode would hold for
 * one of them: the Claude Pro / Max sign-in unless another method ID is given.
 */
async function registeredLogin(
  input: Parameters<typeof claudeLoginMethods>[0],
  methodID: string = CLAUDE_POOL_LOGIN_METHOD_ID,
) {
  let registration: IntegrationOAuthMethodRegistration | undefined
  await registerOpenCode2AuthMethods(
    {
      integration: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            update: () => {},
            remove: () => {},
            method: {
              list: () => [],
              remove: () => {},
              update: (method) => {
                if ('authorize' in method && method.method.id === methodID)
                  registration = method
              },
            },
          })
          return { dispose: async () => {} }
        },
      },
    },
    claudeLoginMethods(input),
  )
  if (!registration)
    throw new Error(`Login method ${methodID} was not registered`)
  return registration
}
function source(
  runtime: NativeAccountRuntime,
  paths: NativePoolPaths,
  owned = cleanups,
) {
  const native = createNativeAnthropicSource({
    runtime,
    paths,
    requestOptions: () => ({}),
  })
  owned.push(() => native.close())
  return native
}
function context(
  provenance: NativeSourceProvenance,
  attemptId = 'attempt-one',
): NativeAnthropicAttemptContext<NativeSourceProvenance> {
  return {
    ...scope,
    accountId: 'main',
    attemptId,
    transport: 'http',
    route: 'oauth',
    dispatch: 'direct',
    provenance,
  }
}
async function vault(
  versions: number[] = [7, 8],
  servedIdentity: (get: number) => string = () => identity,
  routing: { mode: string } = { mode: 'main-first' },
  onLockEvent?: NativeAccountRuntime['onLockEvent'],
) {
  const { paths, env, store: localStore } = await storage()
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  await store.updateSettings(() => ({
    quota: { enabled: false },
    routing,
  }))
  const gets: Parameters<NativeCustodyClient['getScoped']>[0][] = []
  const reports: Parameters<
    NativeCustodyClient['reportAuthFailureScoped']
  >[0][] = []
  const credentialId = 'oauth:anthropic'
  const client: NativeCustodyClient = {
    async listScoped() {
      return {
        view: 'oc2-native-view',
        rows: [
          {
            id: credentialId,
            accountId: identity,
            credentialType: 'oauth',
            categories: ['anthropic-native'],
            refreshAdapter: 'anthropic',
            serves: ['anthropic'],
            providerIds: [],
            operations: ['read'],
            state: 'active',
            recordVersion: 7,
            createdAtMs: null,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped(input) {
      gets.push(input)
      const version =
        versions[Math.min(gets.length - 1, versions.length - 1)] ?? 7
      return {
        credentialId,
        accountId: servedIdentity(gets.length),
        material: `sk-ant-oat01-vault-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3600_000,
      }
    },
    async reportAuthFailureScoped(input) {
      reports.push(input)
    },
    close() {},
  }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: { onLockEvent },
    vault: {
      env,
      connect: async () => client,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    },
  })
  await runtime.vault.refresh()
  const roster = await runtime.vault.read()
  const primary = roster?.rows.find((row) => row.credentialId === credentialId)
  if (!primary) throw new Error('Native vault seed has no asserted primary')
  await store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: primary.routeId,
    claustrum: {
      primaryAccount: { credentialId, accountId: identity, state: 'active' },
    },
  }))
  cleanups.push(() => runtime.close())
  return { runtime, paths, store, localStore, env, gets, reports, client }
}

/**
 * A vault that holds the default Claude account (credential oauth:anthropic)
 * and one fallback account, with sticky-balanced routing. `setDefaultIdentity`
 * makes the vault report a different account UUID for the default credential,
 * as when its Claude account is replaced.
 */
async function vaultWithFallback() {
  const { paths, env } = await storage()
  await writeFile(
    env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  await store.updateSettings(() => ({
    quota: { enabled: false },
    routing: { mode: 'sticky-balanced' },
  }))
  const identities = new Map([
    ['oauth:anthropic', identity],
    ['oauth:anthropic:work', fallbackIdentity],
  ])
  const states = new Map<string, string>()
  let discoveries = 0
  const row = (credentialId: string) => ({
    id: credentialId,
    accountId: identities.get(credentialId) ?? '',
    credentialType: 'oauth' as const,
    categories: ['anthropic-native'],
    refreshAdapter: 'anthropic',
    serves: ['anthropic'],
    providerIds: [],
    operations: ['read'],
    state: states.get(credentialId) ?? 'active',
    recordVersion: 7,
    createdAtMs: null,
  })
  const client: NativeCustodyClient = {
    async listScoped() {
      discoveries++
      return {
        view: `oc2-view-${[...identities.values()].join('-')}-${[...states.values()].join('-')}`,
        rows: [...identities.keys()].map(row),
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped(input) {
      return {
        credentialId: input.credentialId,
        accountId: identities.get(input.credentialId),
        material: `sk-ant-oat01-${input.credentialId}`,
        recordVersion: 7,
        expiresAtMs: Date.now() + 3600_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: {
      env,
      connect: async () => client,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    },
  })
  cleanups.push(() => runtime.close())
  await runtime.vault.refresh()
  const roster = await runtime.vault.read()
  const primary = roster?.rows.find(
    (entry) => entry.credentialId === 'oauth:anthropic',
  )
  if (!primary) throw new Error('Vault seed has no default account')
  await store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: primary.routeId,
    claustrum: {
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: identity,
        state: 'active',
      },
    },
  }))
  return {
    paths,
    runtime,
    client,
    discoveries: () => discoveries,
    setState: (credentialId: string, state: string) =>
      states.set(credentialId, state),
    setDefaultIdentity: (next: string) => {
      identities.set('oauth:anthropic', next)
    },
  }
}
/** The exact stored JSON of one session's pin; sessions are stored under SHA-256 keys. */
function rawPin(text: string, sessionID: string) {
  const key = createHash('sha256').update(sessionID).digest('hex')
  // Pins hold only scalar fields and brace-free strings, so the object's
  // bytes end at its first closing brace.
  const match = text.match(new RegExp(`"${key}":\\s*(\\{[^}]*\\})`))
  if (!match?.[1]) throw new Error('Expected pin is missing')
  return match[1]
}

/** Drives installNativeAnthropic's hooks with the real adapter and account runtime. */
async function retryHost(native: ReturnType<typeof source>) {
  const callbacks = new Map<string, (input: unknown) => unknown>()
  type HostEvent =
    ReturnType<
      NonNullable<OpenCode2HookContext['event']>['subscribe']
    > extends AsyncIterable<infer E>
      ? E
      : never
  const listeners = new Set<{
    events: HostEvent[]
    changed: ReturnType<typeof Promise.withResolvers<void>>
  }>()
  const event: NonNullable<OpenCode2HookContext['event']> = {
    subscribe: async function* (options?: { signal?: AbortSignal }) {
      const signal = options?.signal
      const listener = {
        events: [] as HostEvent[],
        changed: Promise.withResolvers<void>(),
      }
      listeners.add(listener)
      signal?.addEventListener('abort', () => listener.changed.resolve(), {
        once: true,
      })
      try {
        while (!signal?.aborted) {
          const next = listener.events.shift()
          if (next) yield next
          else {
            await listener.changed.promise
            listener.changed = Promise.withResolvers<void>()
          }
        }
      } finally {
        listeners.delete(listener)
      }
    } as NonNullable<OpenCode2HookContext['event']>['subscribe'],
  }
  const hook: OpenCode2HookContext['session']['hook'] = async (name, run) => {
    callbacks.set(name, (input) => run(input as SessionHooks[typeof name]))
    return {
      dispose: async () => {
        callbacks.delete(name)
      },
    }
  }
  const installation = await installNativeAnthropic(
    { session: { hook }, event },
    { source: native },
    { credential: preparedAnthropicCredential },
  )
  cleanups.push(() => installation.dispose())
  async function run<Name extends keyof SessionHooks>(
    name: Name,
    input: SessionHooks[Name],
  ) {
    const callback = callbacks.get(name)
    if (!callback) throw new Error(`Missing installed hook ${name}`)
    await callback(input)
  }
  const hostScope = (input = scope) => ({
    sessionID: input.sessionID as SessionHooks['http.request']['sessionID'],
    agent: input.agent as SessionHooks['http.request']['agent'],
    model: {
      providerID:
        input.providerID as SessionHooks['http.request']['model']['providerID'],
      id: input.modelID as SessionHooks['http.request']['model']['id'],
    },
    kind: input.kind,
  })
  return {
    installation,
    idle() {
      const idle: HostEvent = {
        id: 'evt_native_idle' as HostEvent['id'],
        created: Date.now(),
        type: 'session.status',
        data: {
          sessionID: scope.sessionID as SessionHooks['retry']['sessionID'],
          status: { type: 'idle' },
        },
      }
      for (const listener of listeners) {
        listener.events.push(idle)
        listener.changed.resolve()
      }
    },
    async send(
      input = scope,
      credential: string | { apiKey: string } = placeholderSecret('anthropic'),
    ) {
      const draft = {
        ...hostScope(input),
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            ...(typeof credential === 'string'
              ? { authorization: `Bearer ${credential}` }
              : { 'x-api-key': credential.apiKey }),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: input.modelID,
            max_tokens: 128,
            messages: [{ role: 'user', content: 'retry contract' }],
          }),
        }),
      }
      await run('model.request', { ...hostScope(input), headers: {} })
      await run('http.request', draft)
      return draft.request
    },
    async response(request: Request, status: number, input = scope) {
      const draft = {
        ...hostScope(input),
        request,
        response: new Response('{}', { status }),
      }
      await run('http.response', draft)
      await draft.response.text()
    },
    /** Answers with a 200 event stream whose events the host reads to the end. */
    async streamed(request: Request, events: string, input = scope) {
      const draft = {
        ...hostScope(input),
        request,
        response: new Response(events, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      }
      await run('http.response', draft)
      await draft.response.text()
    },
    async retry(retry = true, input = scope) {
      const draft: SessionHooks['retry'] = {
        ...hostScope(input),
        attempt: 1,
        error: { type: 'unknown', message: 'provider refused the attempt' },
        decision: retry ? { retry: true, delay: 1234 } : { retry: false },
      }
      await run('retry', draft)
      return draft.decision
    },
  }
}

describe('OC2 installed retry contract (requires common-auth 0.30.0)', () => {
  test('mixed session retries vault-newer on the same account without choosing again', async () => {
    const fixture = await vault([7, 8, 9])
    const native = source(fixture.runtime, fixture.paths)
    const choose = spyOn(native, 'chooseAccount')
    const host = await retryHost(native)
    const foreign = await host.send(scope, 'foreign-anthropic-login')
    expect(foreign.headers.get('authorization')).toBe(
      'Bearer foreign-anthropic-login',
    )
    expect(choose).toHaveBeenCalledTimes(0)
    const first = await host.send()
    await host.response(first, 401)
    expect(await host.retry(false)).toEqual({ retry: true, delay: 0 })
    const next = await host.send()
    expect(next.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-vault-8',
    )
    expect(
      host.installation.installation.accountFor(scope.sessionID, scope.kind),
    ).toBe('main')
    expect(choose).toHaveBeenCalledTimes(1)
    expect(fixture.gets).toHaveLength(2)
    await host.response(next, 401)
    expect(await host.retry(false)).toEqual({ retry: false })
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([
      7, 8,
    ])
  })

  test('mixed session retries local-newer on the same account with only one refresh', async () => {
    let refreshes = 0
    const fixture = await local({
      refreshToken: async () => {
        refreshes++
        return {
          access: 'sk-ant-oat01-refreshed',
          refresh: 'rotated-refresh',
          expires: Date.now() + 3600_000,
          expiresIn: 3600,
        }
      },
      resolveIdentity: async () => ({
        accountUuid: identity as ProviderAccountUuid,
        deviceId: 'fixture',
        sessionId: 'fixture',
      }),
    })
    const native = source(fixture.runtime, fixture.paths)
    const choose = spyOn(native, 'chooseAccount')
    const host = await retryHost(native)
    const foreign = await host.send(scope, { apiKey: 'foreign-api-key' })
    expect(foreign.headers.get('x-api-key')).toBe('foreign-api-key')
    expect(choose).toHaveBeenCalledTimes(0)
    const first = await host.send()
    expect(first.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-native-only',
    )
    await host.response(first, 401)
    expect(refreshes).toBe(1)
    expect(await host.retry(false)).toEqual({ retry: true, delay: 0 })
    const next = await host.send()
    expect(next.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-refreshed',
    )
    expect(
      host.installation.installation.accountFor(scope.sessionID, scope.kind),
    ).toBe('main')
    expect(choose).toHaveBeenCalledTimes(1)
    await host.response(next, 401)
    expect(await host.retry(false)).toEqual({ retry: false })
    expect(refreshes).toBe(1)
  })

  for (const failure of ['relay-response', 'network-error'] as const) {
    test(`mixed session retries relay-to-direct on the same account after ${failure}`, async () => {
      const fixture = await vault([7, 8, 9])
      await fixture.runtime.updateRelay({
        enabled: true,
        transport: 'http',
        url: 'https://relay.invalid',
        fallbackToDirect: true,
        token: 'synthetic-relay-token',
      })
      const native = source(fixture.runtime, fixture.paths)
      const choose = spyOn(native, 'chooseAccount')
      const host = await retryHost(native)
      await host.send(scope, 'foreign-anthropic-login')
      const first = await host.send()
      expect(first.url).toBe('https://relay.invalid/')
      if (failure === 'relay-response') await host.response(first, 502)
      expect(await host.retry(false)).toEqual({ retry: true, delay: 0 })
      const next = await host.send()
      expect(next.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
      expect(next.headers.get('authorization')).toBe(
        'Bearer sk-ant-oat01-vault-8',
      )
      expect(next.headers.has('x-relay-token')).toBe(false)
      expect(
        host.installation.installation.accountFor(scope.sessionID, scope.kind),
      ).toBe('main')
      expect(choose).toHaveBeenCalledTimes(1)
      expect(await host.retry(false)).toEqual({ retry: false })
      expect(fixture.gets).toHaveLength(2)
      expect(fixture.reports).toHaveLength(0)
    })
  }

  for (const unused of [
    'host-declines',
    'model-change',
    'agent-change',
    'forgotten',
    'shutdown',
  ] as const) {
    test(`installed ${unused} releases only its pending same-account recovery`, async () => {
      const fixture = await vault([7, 8, 9, 10, 11])
      const native = source(fixture.runtime, fixture.paths)
      const retry = spyOn(native, 'retrySameAccount')
      const originalDrop = native.dropSameAccountRetry?.bind(native)
      const drop = spyOn(native, 'dropSameAccountRetry')
      const dropChoice = spyOn(native, 'dropChoice')
      const host = await retryHost(native)
      await host.send(scope, 'foreign-anthropic-login')
      const first = await host.send()
      await host.response(first, 401)
      expect(await host.retry(false)).toEqual({ retry: true, delay: 0 })
      const released = Promise.withResolvers<void>()
      drop.mockImplementation(async (input) => {
        await originalDrop?.(input)
        released.resolve()
      })
      if (unused === 'host-declines') host.idle()
      else if (unused === 'forgotten')
        host.installation.forgetSession(scope.sessionID)
      else if (unused === 'shutdown') await host.installation.dispose()
      else
        await host.send({
          ...scope,
          ...(unused === 'model-change'
            ? { modelID: 'claude-opus-4-6' }
            : { agent: 'plan' }),
        })
      await released.promise
      expect(drop).toHaveBeenCalledTimes(1)
      expect(drop.mock.calls[0]?.[0]).toEqual(retry.mock.calls[0]?.[0])
      expect(dropChoice).toHaveBeenCalledTimes(0)
      if (unused !== 'shutdown') {
        const next = await host.send()
        expect(next.headers.get('authorization')).toBe(
          `Bearer sk-ant-oat01-vault-${unused === 'model-change' || unused === 'agent-change' ? 10 : 9}`,
        )
      }
      await host.installation.dispose()
      expect(drop).toHaveBeenCalledTimes(1)
    })
  }

  test('installed vault-newer retry consumes one recovery without committing another choice', async () => {
    const fixture = await vault([7, 8, 9], () => identity, {
      mode: 'sticky-balanced',
    })
    const native = source(fixture.runtime, fixture.paths)
    const choose = spyOn(native, 'chooseAccount')
    const drop = spyOn(native, 'dropChoice')
    const host = await retryHost(native)
    const first = await host.send()
    expect(first.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-vault-7',
    )
    await native.drainRoutingPublications()
    const { routingPath } = await fixture.runtime.read()
    if (!routingPath) throw new Error('Missing routing path')
    const pin = await readFile(routingPath, 'utf8')
    await host.response(first, 401)
    expect(await host.retry()).toEqual({ retry: true, delay: 0 })
    const second = await host.send()
    expect(second.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-vault-8',
    )
    expect(choose).toHaveBeenCalledTimes(1)
    expect(
      choose.mock.calls.map(([input]) =>
        'phase' in input ? input.phase : undefined,
      ),
    ).toEqual(['request'])
    await native.drainRoutingPublications()
    expect(await readFile(routingPath, 'utf8')).toBe(pin)
    // The retry above used its prepared credential; a later authorization
    // must get a fresh one, not that credential again.
    expect(await native.authorizeAccount(scope, 'main')).toMatchObject({
      accessToken: 'sk-ant-oat01-vault-9',
    })
    expect(drop).toHaveBeenCalledTimes(0)
    await host.installation.dispose()
    expect(drop).toHaveBeenCalledTimes(0)
  })

  test('installed 429 reroutes once and pins the next attempt to the new account', async () => {
    const fixture = await vaultWithFallback()
    const native = source(fixture.runtime, fixture.paths)
    const choose = spyOn(native, 'chooseAccount')
    const host = await retryHost(native)
    const first = await host.send()
    expect(
      host.installation.installation.accountFor(scope.sessionID, 'primary'),
    ).toBe('main')
    await host.response(first, 429)
    expect(await host.retry(false)).toEqual({ retry: true, delay: 0 })
    const next = await host.send()
    const selected = host.installation.installation.accountFor(
      scope.sessionID,
      'primary',
    )
    expect(selected).toBeDefined()
    expect(selected).not.toBe('main')
    expect(next.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-oauth:anthropic:work',
    )
    expect(choose).toHaveBeenCalledTimes(2)
    expect(
      choose.mock.calls.map(([input]) =>
        'phase' in input ? input.phase : undefined,
      ),
    ).toEqual(['request', 'retry'])
    await native.drainRoutingPublications()
    const { routingPath } = await fixture.runtime.read()
    if (!routingPath) throw new Error('Missing routing path')
    expect(
      JSON.parse(rawPin(await readFile(routingPath, 'utf8'), scope.sessionID)),
    ).toMatchObject({ accountId: selected })
    await host.response(next, 200)
    await host.send()
    expect(choose).toHaveBeenCalledTimes(3)
    expect(
      host.installation.installation.accountFor(scope.sessionID, 'primary'),
    ).toBe(selected)
  })

  test('installed undefined retry preserves the pin and next attempt chooses once without rerouteFrom', async () => {
    const fixture = await local()
    await fixture.runtime.updateSettings((settings) => {
      settings.routing = { mode: 'sticky-balanced' }
    })
    const native = source(fixture.runtime, fixture.paths)
    const choose = spyOn(native, 'chooseAccount')
    const drop = spyOn(native, 'dropChoice')
    const host = await retryHost(native)
    const first = await host.send()
    await native.drainRoutingPublications()
    const { routingPath } = await fixture.runtime.read()
    if (!routingPath) throw new Error('Missing routing path')
    const pin = await readFile(routingPath, 'utf8')
    await host.response(first, 429)
    expect(await host.retry()).toEqual({ retry: true, delay: 1234 })
    await expect(choose.mock.results[1]?.value).resolves.toBeUndefined()
    await native.drainRoutingPublications()
    expect(await readFile(routingPath, 'utf8')).toBe(pin)
    const next = await host.send()
    expect(next.headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-native-only',
    )
    expect(choose).toHaveBeenCalledTimes(3)
    expect(choose.mock.calls[2]?.[0]).not.toHaveProperty('rerouteFrom')
    expect(drop).toHaveBeenCalledTimes(0)
  })

  for (const unused of ['host-no-retry', 'model-change'] as const) {
    test(`installed ${unused} drops exactly its unused queued choice before the next selection`, async () => {
      const fixture = await vault([7, 8, 9, 10, 11, 12], () => identity, {
        mode: 'sticky-balanced',
      })
      const native = source(fixture.runtime, fixture.paths)
      const originalChoose = native.chooseAccount.bind(native)
      const choose = spyOn(native, 'chooseAccount')
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      cleanups.push(() => release.resolve())
      const events: string[] = []
      choose.mockImplementation((input) => {
        events.push(`choose:${input.sessionID}`)
        // Naming the refused account again leaves the retry decision to the
        // host. Retrying on the same account with a newer credential goes
        // through retrySameAccount instead, which asks for an immediate retry.
        if (input.phase === 'retry') return input.rerouteFrom?.accountId
        return originalChoose(input)
      })
      const originalDrop = native.dropChoice?.bind(native)
      const drop = spyOn(native, 'dropChoice').mockImplementation(
        async (input) => {
          events.push('drop:start')
          entered.resolve()
          await release.promise
          await originalDrop?.(input)
          events.push('drop:end')
        },
      )
      const host = await retryHost(native)
      const other = { ...scope, sessionID: 'ses_other_pending' }
      const first = await host.send()
      await host.response(first, 429)
      const otherFirst = await host.send(other)
      await host.response(otherFirst, 429, other)
      await host.retry(true, other)
      await native.drainRoutingPublications()
      const { routingPath } = await fixture.runtime.read()
      if (!routingPath) throw new Error('Missing routing path')
      const pin = rawPin(await readFile(routingPath, 'utf8'), scope.sessionID)
      const nextScope =
        unused === 'model-change'
          ? { ...scope, modelID: 'claude-opus-4-6' }
          : scope
      const retry = host.retry(unused === 'model-change')
      let next: Promise<Request>
      if (unused === 'model-change') {
        await retry
        next = host.send(nextScope)
      } else {
        // The retry hook is still awaiting cleanup when another request arrives.
        await Promise.race([entered.promise, retry])
        expect(drop).toHaveBeenCalledTimes(1)
        next = host.send(nextScope)
      }
      await Promise.race([entered.promise, next])
      expect(choose).toHaveBeenCalledTimes(4)
      expect(drop).toHaveBeenCalledTimes(1)
      const retryInput = choose.mock.calls[3]?.[0]
      if (!retryInput) throw new Error('Missing retry choice input')
      expect(drop.mock.calls[0]?.[0]).toEqual({
        ...retryInput,
        accountId: 'main',
      })
      await native.drainRoutingPublications()
      expect(rawPin(await readFile(routingPath, 'utf8'), scope.sessionID)).toBe(
        pin,
      )
      release.resolve()
      await retry
      expect((await next).headers.get('authorization')).toBe(
        'Bearer sk-ant-oat01-vault-9',
      )
      expect(events.slice(-3)).toEqual([
        'drop:start',
        'drop:end',
        `choose:${scope.sessionID}`,
      ])
      expect((await host.send(other)).headers.get('authorization')).toBe(
        'Bearer sk-ant-oat01-vault-10',
      )
      expect(choose).toHaveBeenCalledTimes(5)
      // Reading the old scope would consume a leaked choice, even after a model change.
      expect(await native.authorizeAccount(scope, 'main')).toMatchObject({
        accessToken: 'sk-ant-oat01-vault-11',
      })
      await host.installation.dispose()
      expect(drop).toHaveBeenCalledTimes(1)
    })
  }
})

/**
 * Publishes a fresh reading for the vault default account whose five-hour
 * window is exhausted and resets at `resetAt`.
 */
async function exhaustDefault(
  fixture: Awaited<ReturnType<typeof vaultWithFallback>>,
  resetAt: number,
  checkedAt = Date.now(),
) {
  const receipt = await fixture.runtime.authorizeVault('main')
  await fixture.runtime.vault.publish(receipt, {
    quota: {
      accountIdentity: identity,
      checkedAt,
      five_hour: {
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt,
        resetsAt: new Date(resetAt).toISOString(),
      },
      seven_day: { usedPercent: 10, remainingPercent: 90, checkedAt },
    },
  })
}

/** Runs `work` with the clock stopped at `now`, so reset arithmetic is exact. */
async function atTime<T>(now: number, work: () => Promise<T>) {
  setSystemTime(new Date(now))
  try {
    return await work()
  } finally {
    setSystemTime()
  }
}

describe('OC2 installed sticky quota hold (requires common-auth 0.27.0)', () => {
  const mainBearer = 'Bearer sk-ant-oat01-oauth:anthropic'
  const fallbackBearer = 'Bearer sk-ant-oat01-oauth:anthropic:work'

  async function heldSession(sessionID = scope.sessionID) {
    const fixture = await vaultWithFallback()
    const native = source(fixture.runtime, fixture.paths)
    const choose = spyOn(native, 'chooseAccount')
    const drop = spyOn(native, 'dropChoice')
    const host = await retryHost(native)
    const session = { ...scope, sessionID }
    const first = await host.send(session)
    const accountFor = () =>
      host.installation.installation.accountFor(sessionID, 'primary')
    expect(accountFor()).toBe('main')
    expect(first.headers.get('authorization')).toBe(mainBearer)
    await native.drainRoutingPublications()
    const { routingPath } = await fixture.runtime.read()
    if (!routingPath) throw new Error('Missing routing path')
    const pin = await readFile(routingPath, 'utf8')
    return {
      fixture,
      native,
      choose,
      drop,
      host,
      session,
      first,
      accountFor,
      routingPath,
      pin,
    }
  }

  test('a 429 with a short reset holds the session on its account for the jittered reset, keeping its pin', async () => {
    const f = await heldSession()
    const now = Date.now()
    await exhaustDefault(f.fixture, now + 120_000, now)
    await f.host.response(f.first, 429, f.session)
    // The host would not retry this error; the hold retries it after our wait.
    expect(await atTime(now, () => f.host.retry(false, f.session))).toEqual({
      retry: true,
      delay: stickyRetryAfterWithJitter(f.session.sessionID, 120) * 1000,
    })
    expect(f.choose.mock.calls[1]?.[0]).toMatchObject({
      phase: 'retry',
      rerouteFrom: { accountId: 'main', limit: { status: 429 } },
    })
    await f.native.drainRoutingPublications()
    expect(await readFile(f.routingPath, 'utf8')).toBe(f.pin)
    const next = await f.host.send(f.session)
    expect(next.headers.get('authorization')).toBe(mainBearer)
    expect(f.accountFor()).toBe('main')
    // The held retry is served by the queued choice, not a new selection.
    expect(f.choose).toHaveBeenCalledTimes(2)
    expect(f.drop).toHaveBeenCalledTimes(0)
    await f.native.drainRoutingPublications()
    expect(
      JSON.parse(
        rawPin(await readFile(f.routingPath, 'utf8'), f.session.sessionID),
      ),
    ).toMatchObject({ accountId: 'main' })
  })

  test('a 429 whose reset is beyond fifteen minutes moves the session to another account', async () => {
    const f = await heldSession()
    const now = Date.now()
    await exhaustDefault(f.fixture, now + 60 * 60_000, now)
    await f.host.response(f.first, 429, f.session)
    expect(await atTime(now, () => f.host.retry(true, f.session))).toEqual({
      retry: true,
      delay: 0,
    })
    const next = await f.host.send(f.session)
    expect(next.headers.get('authorization')).toBe(fallbackBearer)
    expect(f.accountFor()).not.toBe('main')
  })

  test('a reset exactly fifteen minutes away holds for 920 seconds with the largest jitter, below the installer cap', async () => {
    let sessionID = ''
    for (let index = 0; !sessionID; index++) {
      const candidate = `ses_hold_boundary_${index}`
      if (stickyRetryAfterWithJitter(candidate, 900) === 920)
        sessionID = candidate
    }
    const f = await heldSession(sessionID)
    const now = Date.now()
    await exhaustDefault(f.fixture, now + 15 * 60_000, now)
    await f.host.response(f.first, 429, f.session)
    expect(await atTime(now, () => f.host.retry(true, f.session))).toEqual({
      retry: true,
      delay: 920_000,
    })
    expect((await f.host.send(f.session)).headers.get('authorization')).toBe(
      mainBearer,
    )
  })

  test('a rate limit after output has started never holds or retries', async () => {
    const f = await heldSession()
    const now = Date.now()
    await exhaustDefault(f.fixture, now + 120_000, now)
    await f.host.streamed(
      f.first,
      [
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
        '',
        'event: error',
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
        '',
        '',
      ].join('\n'),
      f.session,
    )
    expect(await atTime(now, () => f.host.retry(true, f.session))).toEqual({
      retry: false,
    })
    expect(f.choose).toHaveBeenCalledTimes(1)
    await f.native.drainRoutingPublications()
    expect(await readFile(f.routingPath, 'utf8')).toBe(f.pin)
  })

  for (const change of ['model', 'agent'] as const) {
    test(`a held retry whose ${change} changed releases the held choice and selects again`, async () => {
      const f = await heldSession()
      const now = Date.now()
      await exhaustDefault(f.fixture, now + 120_000, now)
      // A changed model places the session again; that needs a reading for
      // the other account too, or the incomplete pool refuses placement.
      const fallback = (await f.fixture.runtime.read()).accounts.find(
        (account) => account.id !== 'main',
      )
      if (!fallback) throw new Error('Missing fallback account')
      await f.fixture.runtime.vault.publish(
        await f.fixture.runtime.authorizeVault(fallback.id),
        {
          quota: {
            accountIdentity: fallbackIdentity,
            checkedAt: now,
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: now,
            },
            seven_day: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: now,
            },
          },
        },
      )
      await f.host.response(f.first, 429, f.session)
      expect(
        (await atTime(now, () => f.host.retry(true, f.session))).retry,
      ).toBe(true)
      const changed =
        change === 'model'
          ? { ...f.session, modelID: 'claude-haiku-4-5' }
          : { ...f.session, agent: 'plan' }
      await f.host.send(changed)
      expect(f.drop).toHaveBeenCalledTimes(1)
      expect(f.drop.mock.calls[0]?.[0]).toMatchObject({
        accountId: 'main',
        modelID: f.session.modelID,
        agent: f.session.agent,
      })
      expect(f.choose).toHaveBeenCalledTimes(3)
      const reselect = f.choose.mock.calls[2]?.[0]
      expect(reselect).toMatchObject({
        phase: 'request',
        modelID: changed.modelID,
        agent: changed.agent,
        previousAccountId: 'main',
      })
      expect(reselect).not.toHaveProperty('rerouteFrom')
    })
  }
})

describe('OC2 source over actual native services', () => {
  usageTests.test(
    'OC2 quota preflight skips an enabled vault account needing sign-in',
    async () => {
      const f = await vaultWithFallback()
      f.setState('oauth:anthropic:work', 'needs_reauth')
      await f.runtime.vault.refresh()
      await f.runtime.updateSettings((settings) => ({
        ...settings,
        quota: { enabled: true, failClosedOnUnknownQuota: false },
        routing: { mode: 'fallback-first' },
      }))
      expect(
        (await f.runtime.read()).accounts.find(
          (account) => account.credentialId === 'oauth:anthropic:work',
        ),
      ).toMatchObject({ enabled: true, state: 'needs_reauth' })
      const poll = spyOn(f.runtime, 'fetchQuota').mockResolvedValue({
        checkedAt: Date.now(),
        five_hour: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: Date.now(),
        },
        seven_day: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: Date.now(),
        },
      })
      cleanups.push(() => poll.mockRestore())
      expect(await source(f.runtime, f.paths).chooseAccount(scope)).toBe('main')
      expect(poll.mock.calls.map(([id]) => id)).toEqual(['main'])
    },
  )

  usageTests.test(
    'healthy native vault requests do not refresh or discover the ready roster',
    async () => {
      const f = await vaultWithFallback()
      const snapshot = await f.runtime.read()
      expect(snapshot.mode).toBe('claustrum')
      expect(snapshot.policyStorage.claustrum?.scopedRoster).toBeUndefined()
      const refresh = spyOn(f.runtime.vault, 'refresh')
      cleanups.push(() => refresh.mockRestore())
      const before = f.discoveries()
      const native = source(f.runtime, f.paths)
      for (let request = 0; request < 4; request++) {
        const chosen = await native.chooseAccount({
          ...scope,
          sessionID: `healthy-${request}`,
        })
        if (typeof chosen !== 'string') throw new Error('No account chosen')
        expect((await native.authorizeAccount(scope, chosen))?.route).toBe(
          'oauth',
        )
      }
      expect(refresh).toHaveBeenCalledTimes(0)
      expect(f.discoveries() - before).toBe(0)
    },
  )

  usageTests.test(
    'inactive native vault admission coalesces one refresh and serves a recovered account',
    async () => {
      const f = await vaultWithFallback()
      f.setState('oauth:anthropic', 'needs_reauth')
      f.setState('oauth:anthropic:work', 'needs_reauth')
      await f.runtime.vault.refresh()
      expect(
        (await f.runtime.read()).policyStorage.claustrum?.scopedRoster,
      ).toBeUndefined()
      f.setState('oauth:anthropic', 'active')
      const entered = usageTests.gate()
      const release = usageTests.gate()
      const list = f.client.listScoped
      f.client.listScoped = async (...args) => {
        entered.open()
        await release.wait
        return list(...args)
      }
      const refresh = spyOn(f.runtime.vault, 'refresh')
      cleanups.push(() => refresh.mockRestore())
      const before = f.discoveries()
      const requests = [
        readNativeAccountsForRequest(f.runtime),
        readNativeAccountsForRequest(f.runtime),
      ]
      for (const request of requests)
        usageTests.trackDetached(
          request.then(
            () => {},
            () => {},
          ),
        )
      try {
        await entered.wait
        await Promise.resolve()
        release.open()
        const snapshots = await Promise.all(requests)
        for (const snapshot of snapshots)
          expect(
            snapshot.accounts.find((account) => account.id === 'main')?.state,
          ).toBe('active')
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(f.discoveries() - before).toBe(1)
      } finally {
        release.open()
      }
    },
  )

  usageTests.test(
    'inactive native vault admission refreshes once before its fixed refusal',
    async () => {
      const f = await vaultWithFallback()
      f.setState('oauth:anthropic', 'needs_reauth')
      f.setState('oauth:anthropic:work', 'needs_reauth')
      await f.runtime.vault.refresh()
      const refresh = spyOn(f.runtime.vault, 'refresh')
      cleanups.push(() => refresh.mockRestore())
      const before = f.discoveries()
      await expect(
        readNativeAccountsForRequest(f.runtime),
      ).rejects.toMatchObject({
        message:
          'No vault account can serve this request. Open /claude to see which account needs signing in again.',
      })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(f.discoveries() - before).toBe(1)
    },
  )

  usageTests.test(
    'inactive native vault admission bounds a stalled refresh at two seconds',
    async () => {
      const f = await vaultWithFallback()
      f.setState('oauth:anthropic', 'needs_reauth')
      f.setState('oauth:anthropic:work', 'needs_reauth')
      await f.runtime.vault.refresh()
      const release = usageTests.gate()
      const list = f.client.listScoped
      let calls = 0
      f.client.listScoped = async (...args) => {
        calls++
        await release.wait
        return list(...args)
      }
      const refresh = spyOn(f.runtime.vault, 'refresh')
      cleanups.push(() => refresh.mockRestore())
      const started = performance.now()
      try {
        await expect(
          readNativeAccountsForRequest(f.runtime),
        ).rejects.toMatchObject({
          message:
            'No vault account can serve this request. Open /claude to see which account needs signing in again.',
        })
        // The stalled refresh holds the full two-second admission budget
        // before the refusal: removing or shortening that production budget
        // fails the wait below. There is deliberately no upper bound — a
        // loaded runner only makes a correct wait longer.
        expect(performance.now() - started).toBeGreaterThanOrEqual(1900)
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(calls).toBe(1)
        f.setState('oauth:anthropic', 'active')
        release.open()
        expect(
          (await readNativeAccountsForRequest(f.runtime)).accounts.find(
            (account) => account.id === 'main',
          )?.state,
        ).toBe('active')
      } finally {
        release.open()
      }
    },
  )

  for (const mode of [
    'main-first',
    'fallback-first',
    'sticky-balanced',
  ] as const) {
    usageTests.test(
      `OC2 vault reauth recovers on the next request in ${mode}`,
      async () => {
        const f = await vaultWithFallback()
        await f.runtime.updateSettings((settings) => ({
          ...settings,
          routing: { mode },
        }))
        f.setState('oauth:anthropic', 'needs_reauth')
        await f.runtime.vault.refresh()
        const native = source(f.runtime, f.paths)
        const chosen = await native.chooseAccount(scope)
        if (typeof chosen !== 'string') throw new Error('No account chosen')
        expect(chosen).not.toBe('main')
        const first = await native.authorizeAccount(scope, chosen)
        expect(first?.route).toBe('oauth')
        expect(first?.provenance.kind).toBe('vault')
        f.setState('oauth:anthropic', 'active')
        f.setState('oauth:anthropic:work', 'needs_reauth')
        await f.runtime.vault.refresh()
        expect(await native.chooseAccount(scope)).toBe('main')
        expect((await native.authorizeAccount(scope, 'main'))?.route).toBe(
          'oauth',
        )
        f.setState('oauth:anthropic', 'needs_reauth')
        await f.runtime.vault.refresh()
        for (let attempt = 0; attempt < 2; attempt++)
          await expect(native.chooseAccount(scope)).rejects.toMatchObject({
            message:
              'No vault account can serve this request. Open /claude to see which account needs signing in again.',
          })
        f.setState('oauth:anthropic', 'active')
        expect(await native.chooseAccount(scope)).toBe('main')
      },
    )
  }

  test('queued newer vault receipts recheck exact-model admission after a relay-config wait', async () => {
    const fixture = await vault([7, 8, 8])
    const native = source(fixture.runtime, fixture.paths)
    const fable = { ...scope, modelID: 'claude-fable-5-1' }
    const first = await native.authorizeAccount(fable, 'main')
    if (!first) throw new Error('Initial native authorization was refused')
    const limit = await native.limitFromResponse?.({
      ...context(first.provenance),
      modelID: fable.modelID,
      status: 401,
      headers: new Headers({ 'request-id': 'req_native_rejected' }),
      body: async () => '{}',
    })
    if (!limit) throw new Error('Newer native receipt was not offered')
    const receipt = await fixture.runtime.authorizeVault('main')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
        scoped: [
          {
            id: 'seven_day_fable',
            title: 'Fable weekly',
            modelId: fable.modelID,
            modelName: 'Fable 5.1',
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            checkedAt,
          },
        ],
      }
    }
    await fixture.runtime.vault.publish(receipt, { quota: quota(100) })
    expect(
      await native.retrySameAccount?.(sameAccountInput(limit, fable)),
    ).toEqual({ accountId: 'main' })
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      token: 'synthetic-relay-token',
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.runtime.getRelayConfig.bind(fixture.runtime)
    const delayed = spyOn(fixture.runtime, 'getRelayConfig').mockImplementation(
      async () => {
        entered.resolve()
        await release.promise
        return original()
      },
    )
    cleanups.push(() => {
      release.resolve()
      delayed.mockRestore()
    })
    const pending = native.authorizeAccount(fable, 'main')
    await entered.promise
    await fixture.runtime.vault.publish(receipt, { quota: quota(0) })
    release.resolve()
    expect(await pending).toBeUndefined()
    delayed.mockRestore()
    expect((await native.authorizeAccount(scope, 'main'))?.route).toBe('oauth')
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([7])
  })
  test('final dispatch admission closes a paid route whose general exhaustion ended after authorization', async () => {
    const fixture = await local()
    await fixture.runtime.addApi({
      routeId: 'paid',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api-route.invalid',
      authHeader: 'x-api-key',
    })
    const localCredential = await fixture.runtime.authorizeLocal('main')
    if (localCredential.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: {
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
      }
    }
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(0),
    })
    const native = source(fixture.runtime, fixture.paths)
    const auth = await native.authorizeAccount(scope, 'paid')
    if (auth?.route !== 'api')
      throw new Error('Confirmed general exhaustion did not admit paid route')
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(100),
    })
    await expect(
      native.admitRequest?.({
        ...context(auth.provenance),
        accountId: 'paid',
        route: 'api',
      }),
    ).rejects.toThrow('policy changed before dispatch')
    expect((await native.authorizeAccount(scope, 'main'))?.route).toBe('oauth')
  })
  test('delayed vault authorization rechecks exact-model policy before releasing a bearer', async () => {
    const fixture = await vault([7, 7, 7])
    const receipt = await fixture.runtime.authorizeVault('main')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
        scoped: [
          {
            id: 'seven_day_fable',
            title: 'Fable weekly',
            modelId: 'claude-fable-5-1',
            modelName: 'Fable 5.1',
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            checkedAt,
          },
        ],
      }
    }
    await fixture.runtime.vault.publish(receipt, { quota: quota(100) })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.runtime.authorizeVault.bind(fixture.runtime)
    const delayed = spyOn(fixture.runtime, 'authorizeVault').mockImplementation(
      async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
      },
    )
    cleanups.push(() => {
      release.resolve()
      delayed.mockRestore()
    })
    const native = source(fixture.runtime, fixture.paths)
    const pending = native.authorizeAccount(
      { ...scope, modelID: 'claude-fable-5-1' },
      'main',
    )
    await entered.promise
    await fixture.runtime.vault.publish(receipt, { quota: quota(0) })
    release.resolve()
    expect(await pending).toBeUndefined()
    delayed.mockRestore()
    expect((await native.authorizeAccount(scope, 'main'))?.route).toBe('oauth')
    expect(fixture.reports).toHaveLength(0)
  })
  test('delayed paid API authorization rechecks general exhaustion before releasing a key', async () => {
    const fixture = await local()
    await fixture.runtime.addApi({
      routeId: 'paid',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api-route.invalid',
      authHeader: 'x-api-key',
    })
    const localCredential = await fixture.runtime.authorizeLocal('main')
    if (localCredential.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const quota = (remainingPercent: number) => {
      const checkedAt = Date.now()
      return {
        accountIdentity: identity,
        checkedAt,
        five_hour: {
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
      }
    }
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(0),
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = fixture.runtime.authorizeApi.bind(fixture.runtime)
    const delayed = spyOn(fixture.runtime, 'authorizeApi').mockImplementation(
      async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
      },
    )
    cleanups.push(() => {
      release.resolve()
      delayed.mockRestore()
    })
    const native = source(fixture.runtime, fixture.paths)
    const pending = native.authorizeAccount(scope, 'paid')
    await entered.promise
    await fixture.runtime.publishLocal(localCredential.subject, {
      quota: quota(100),
    })
    release.resolve()
    expect(await pending).toBeUndefined()
  })
  test('model aliases use request-local scoped quota without contaminating other model requests', async () => {
    const fixture = await local()
    const authorized = await fixture.runtime.authorizeLocal('main')
    if (authorized.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const checkedAt = Date.now()
    await fixture.runtime.publishLocal(authorized.subject, {
      quota: {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
        scoped: [
          {
            id: 'seven_day_fable',
            title: 'Fable weekly',
            modelId: 'claude-fable-5-1',
            modelName: 'Fable 5.1',
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt,
          },
        ],
      },
    })
    const native = createNativeAnthropicSource({
      runtime: fixture.runtime,
      paths: fixture.paths,
      requestOptions: () => ({}),
      resolveModelId: async (input) =>
        input.modelID === 'custom-fable' ? 'claude-fable-5-1' : input.modelID,
    })
    cleanups.push(() => native.close())
    expect(
      await native.chooseAccount({ ...scope, modelID: 'custom-fable' }),
    ).toBeUndefined()
    expect(await native.chooseAccount(scope)).toBe('main')
    expect(
      await native.authorizeAccount(
        { ...scope, modelID: 'custom-fable' },
        'main',
      ),
    ).toBeUndefined()
  })
  test('paid API credentials require fresh general OAuth exhaustion, not a scoped window alone', async () => {
    const fixture = await local()
    await fixture.runtime.addApi({
      routeId: 'paid',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api-route.invalid',
      authHeader: 'x-api-key',
    })
    const authorized = await fixture.runtime.authorizeLocal('main')
    if (authorized.status !== 'usable')
      throw new Error('Native proof was not admitted')
    const native = source(fixture.runtime, fixture.paths)
    const checkedAt = Date.now()
    const quota = {
      accountIdentity: identity,
      checkedAt,
      five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
      scoped: [
        {
          id: 'seven_day_fable',
          title: 'Fable weekly',
          modelId: 'claude-fable-5-1',
          modelName: 'Fable 5.1',
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt,
        },
      ],
    }
    await fixture.runtime.publishLocal(authorized.subject, { quota })
    expect(
      await native.authorizeAccount(
        { ...scope, modelID: 'claude-fable-5-1' },
        'paid',
      ),
    ).toBeUndefined()
    await fixture.runtime.publishLocal(authorized.subject, {
      quota: {
        ...quota,
        five_hour: { usedPercent: 100, remainingPercent: 0, checkedAt },
      },
    })
    const api = await native.authorizeAccount(scope, 'paid')
    expect(api?.route).toBe('api')
    if (api?.route !== 'api')
      throw new Error('Confirmed exhaustion did not admit API route')
    expect(api.headers['x-api-key']).toBe('synthetic-api-key')
  })
  test('local serving uses positive native proof and never the poisoned legacy credentials', async () => {
    const fixture = await local()
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const auth = await native.authorizeAccount(scope, 'main')
    expect(auth?.route).toBe('oauth')
    if (auth?.route !== 'oauth')
      throw new Error('Local native authorization refused')
    expect(auth.accessToken).toBe('sk-ant-oat01-native-only')
    expect(auth.provenance.kind).toBe('local')
    expect(JSON.stringify(auth.provenance)).not.toContain(auth.accessToken)
    const snapshot = await fixture.runtime.read()
    expect(JSON.stringify(snapshot)).not.toContain('native-only-refresh')
    expect(JSON.stringify(snapshot)).not.toContain(auth.accessToken)
  })
  test('remembers the account that served each session until the session is forgotten', async () => {
    const fixture = await local()
    const native = source(fixture.runtime, fixture.paths)
    expect(native.servedAccount(scope.sessionID)).toBeUndefined()
    expect(await native.authorizeAccount(scope, 'main')).toBeDefined()
    expect(native.servedAccount(scope.sessionID)).toBe('main')
    expect(native.servedAccount('ses_never_served')).toBeUndefined()
    native.forgetSession?.(scope.sessionID)
    expect(native.servedAccount(scope.sessionID)).toBeUndefined()
  })
  test('genuine header quota is account/version bound and persists through native publication', async () => {
    const fixture = await local()
    const native = source(fixture.runtime, fixture.paths)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('Native authorization refused')
    const request = context(auth.provenance)
    const quota = native.quotaFromHeaders?.(
      new Headers({
        'request-id': 'req_native_oc2',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
      }),
      { ...request, status: 200 },
    )
    expect(quota?.five_hour?.remainingPercent).toBe(58)
    await native.onAttemptEnd?.(request, { status: 200, outputStarted: true })
    // Attempt completion does not wait for storage; disposal owns durability.
    await native.close()
    const view = await fixture.runtime.read()
    expect(
      view.accounts.find((account) => account.id === 'main')?.quota?.five_hour
        ?.remainingPercent,
    ).toBe(58)
    expect(
      view.accounts.find((account) => account.id === 'main')?.quota
        ?.accountIdentity,
    ).toBe(identity)
  })
  test('selected WebSocket is refused from secret-free policy before any vault get or provider send', async () => {
    const fixture = await vault()
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'websocket',
      url: 'https://relay.invalid',
      token: 'synthetic-relay-token',
    })
    const native = source(fixture.runtime, fixture.paths)
    const adapter = createNativeAnthropicAdapter({ source: native })
    await expect(adapter.adapter.chooseAccount(scope)).rejects.toBeInstanceOf(
      NativeAnthropicTransportRefusal,
    )
    expect(fixture.gets).toHaveLength(0)
    expect(fixture.reports).toHaveLength(0)
  })
  test('a relay saved without a transport dispatches over HTTP relay, not the WebSocket refusal', async () => {
    const fixture = await vault()
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      token: 'synthetic-relay-token',
    })
    await fixture.store.updateSettings((settings) => {
      const { transport: _omitted, ...relay } = settings.relay as Record<
        string,
        unknown
      >
      settings.relay = relay
    })
    expect(
      (await fixture.runtime.read()).policyStorage.relay?.transport,
    ).toBeUndefined()
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const auth = await native.authorizeAccount(scope, 'main')
    expect(auth?.dispatch).toMatchObject({
      kind: 'http-relay',
      url: 'https://relay.invalid',
    })
  })
  test('a relay saved with a wss URL and no transport is refused as WebSocket before any vault get', async () => {
    const fixture = await vault()
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'websocket',
      url: 'wss://relay.invalid',
      token: 'synthetic-relay-token',
    })
    await fixture.store.updateSettings((settings) => {
      const { transport: _omitted, ...relay } = settings.relay as Record<
        string,
        unknown
      >
      settings.relay = relay
    })
    expect(
      (await fixture.runtime.read()).policyStorage.relay?.transport,
    ).toBeUndefined()
    const native = source(fixture.runtime, fixture.paths)
    const adapter = createNativeAnthropicAdapter({ source: native })
    const refused = adapter.adapter.chooseAccount(scope)
    await expect(refused).rejects.toBeInstanceOf(
      NativeAnthropicTransportRefusal,
    )
    await expect(refused).rejects.toThrow(
      'request refused: WebSocket relay is not supported on OpenCode 2; select HTTP relay or direct transport',
    )
    expect(fixture.gets).toHaveLength(0)
  })
  test('vault 401 reports each physical version and permits exactly one strict-newer same-account retry', async () => {
    const fixture = await vault()
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    const firstAttempt = context(first.provenance)
    const limit = await native.limitFromResponse?.({
      ...firstAttempt,
      status: 401,
      headers: new Headers({ 'request-id': 'req_vault_one' }),
      body: async () => '{}',
    })
    expect(limit?.status).toBe(401)
    if (!limit) throw new Error('Strict-newer retry was not offered')
    expect(await native.retrySameAccount?.(sameAccountInput(limit))).toEqual({
      accountId: 'main',
    })
    const second = await native.authorizeAccount(scope, 'main')
    if (second?.route !== 'oauth')
      throw new Error('Retry authorization refused')
    expect(second.accessToken).toBe('sk-ant-oat01-vault-8')
    expect(JSON.stringify(second.provenance)).not.toContain(second.accessToken)
    await native.onAttemptEnd?.(firstAttempt, {
      status: 401,
      outputStarted: false,
    })
    const secondAttempt = context(second.provenance, 'attempt-two')
    expect(
      await native.limitFromResponse?.({
        ...secondAttempt,
        status: 401,
        headers: new Headers({ 'request-id': 'req_vault_two' }),
        body: async () => '{}',
      }),
    ).toBeUndefined()
    await native.onAttemptEnd?.(secondAttempt, {
      status: 401,
      outputStarted: false,
    })
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([
      7, 8,
    ])
  })
  // OpenCode 2 reports a vault 401 when it arrives, before re-authorizing.
  // The source's session signal is the cancellation that reaches the
  // re-authorization; a cancel there must reject, not offer a reroute.
  test('vault 401 re-authorization cancelled with its session rejects after one report and keeps the sticky account', async () => {
    const fixture = await vaultWithFallback()
    const reports: string[] = []
    fixture.client.reportAuthFailureScoped = async (input) => {
      reports.push(`${input.credentialId}:${input.providerStatus}`)
    }
    const native = source(fixture.runtime, fixture.paths)
    const session = { ...scope, sessionID: 'ses_vault_cancel_reauth' }
    expect(await native.chooseAccount(session)).toBe('main')
    const served = await native.authorizeAccount(session, 'main')
    if (!served) throw new Error('Vault authorization refused')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const get = fixture.client.getScoped.bind(fixture.client)
    fixture.client.getScoped = async (input) => {
      entered.resolve()
      await release.promise
      return get(input)
    }
    cleanups.push(() => release.resolve())
    const pending = native.limitFromResponse?.({
      ...context(served.provenance),
      sessionID: session.sessionID,
      status: 401,
      headers: new Headers({ 'request-id': 'req_vault_cancel' }),
      body: async () => '{}',
    })
    await entered.promise
    native.forgetSession?.(session.sessionID)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    release.resolve()
    fixture.client.getScoped = get
    expect(reports).toEqual(['oauth:anthropic:401'])
    expect(await native.chooseAccount(session)).toBe('main')
  })
  test('unchanged vault version cannot authorize a 401 retry', async () => {
    const fixture = await vault([7, 7])
    const native = source(fixture.runtime, fixture.paths)
    await native.chooseAccount(scope)
    const auth = await native.authorizeAccount(scope, 'main')
    if (!auth) throw new Error('Vault authorization refused')
    expect(
      await native.limitFromResponse?.({
        ...context(auth.provenance),
        status: 401,
        headers: new Headers({ 'request-id': 'req_unchanged' }),
        body: async () => '{}',
      }),
    ).toBeUndefined()
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([7])
  })
  test('relay-to-direct fallback obtains a fresh receipt and does not report the relay-local 401', async () => {
    const fixture = await vault([7, 8])
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      fallbackToDirect: true,
      token: 'synthetic-relay-token',
    })
    const native = source(fixture.runtime, fixture.paths)
    await native.chooseAccount(scope)
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    expect(first.dispatch?.kind).toBe('http-relay')
    const limit = await native.limitFromRelayFailure?.({
      ...context(first.provenance),
      dispatch: 'http-relay',
      status: 401,
    })
    if (!limit) throw new Error('Direct fallback was not offered')
    await native.onAttemptEnd?.(
      { ...context(first.provenance), dispatch: 'http-relay' },
      { outputStarted: false },
    )
    await native.retrySameAccount?.(sameAccountInput(limit))
    const direct = await native.authorizeAccount(scope, 'main')
    expect(direct?.dispatch?.kind).toBe('direct')
    if (direct?.route !== 'oauth')
      throw new Error('Direct authorization refused')
    expect(direct.accessToken).toBe('sk-ant-oat01-vault-8')
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports).toHaveLength(0)
  })
  test('same-account recovery rejects a different scope or a replaced account', async () => {
    const fixture = await vault([7, 8])
    const native = source(fixture.runtime, fixture.paths)
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    const limit = await native.limitFromResponse?.({
      ...context(first.provenance),
      status: 401,
      headers: new Headers(),
      body: async () => '{}',
    })
    if (!limit) throw new Error('Strict-newer retry was not offered')
    const input = sameAccountInput(limit)
    for (const wrong of [
      { accountId: 'other' },
      { sessionID: 'other' },
      { agent: 'plan' },
      { modelID: 'other' },
      { kind: 'compaction' as const },
      { providerID: 'other' },
    ]) {
      expect(
        await native.retrySameAccount?.({ ...input, ...wrong }),
      ).toBeUndefined()
    }
    expect(await native.retrySameAccount?.(input)).toEqual({
      accountId: 'main',
    })
    const snapshot = await fixture.runtime.read()
    const read = spyOn(fixture.runtime, 'read').mockResolvedValue({
      ...snapshot,
      accounts: snapshot.accounts.map((account) => ({
        ...account,
        accountIdentity: changedIdentity,
      })),
    })
    try {
      expect(await native.authorizeAccount(scope, 'main')).toBeUndefined()
    } finally {
      read.mockRestore()
    }
    expect(fixture.gets).toHaveLength(2)
  })
  test('a declined same-account recovery releases its prepared state', async () => {
    const fixture = await local()
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      fallbackToDirect: true,
      token: 'synthetic-relay-token',
    })
    const native = source(fixture.runtime, fixture.paths)
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Local authorization refused')
    const limit = await native.limitFromRelayFailure?.({
      ...context(first.provenance),
      dispatch: 'http-relay',
      status: 502,
    })
    if (!limit) throw new Error('Direct fallback was not offered')
    const input = sameAccountInput(limit)
    const snapshot = await fixture.runtime.read()
    const read = spyOn(fixture.runtime, 'read').mockResolvedValue({
      ...snapshot,
      accounts: [],
    })
    try {
      expect(await native.retrySameAccount?.(input)).toBeUndefined()
      read.mockResolvedValue({
        ...snapshot,
        accounts: snapshot.accounts.map((account) => ({
          ...account,
          enabled: false,
        })),
      })
      expect(await native.retrySameAccount?.(input)).toBeUndefined()
    } finally {
      read.mockRestore()
    }
    expect(await native.retrySameAccount?.(input)).toBeUndefined()
    expect((await native.authorizeAccount(scope, 'main'))?.dispatch).toEqual({
      kind: 'http-relay',
      url: 'https://relay.invalid',
      token: 'synthetic-relay-token',
    })
    expect(await native.retrySameAccount?.(input)).toBeUndefined()
  })
  test('dropping a same-account recovery removes only its matching scoped retry', async () => {
    const fixture = await vault([7, 8, 9])
    await fixture.runtime.updateRelay({
      enabled: true,
      transport: 'http',
      url: 'https://relay.invalid',
      fallbackToDirect: true,
      token: 'synthetic-relay-token',
    })
    const native = source(fixture.runtime, fixture.paths)
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    const unused = await native.limitFromResponse?.({
      ...context(first.provenance, 'unused'),
      dispatch: 'http-relay',
      status: 401,
      headers: new Headers(),
      body: async () => '{}',
    })
    const kept = await native.limitFromRelayFailure?.({
      ...context(first.provenance, 'kept'),
      dispatch: 'http-relay',
      status: 502,
    })
    for (const limit of [unused, kept]) {
      if (!limit) throw new Error('Direct fallback was not offered')
      expect(await native.retrySameAccount?.(sameAccountInput(limit))).toEqual({
        accountId: 'main',
      })
    }
    const drop = native.dropSameAccountRetry
    expect(typeof drop).toBe('function')
    if (!drop || !unused) throw new Error('Missing same-account recovery')
    const input = sameAccountInput(unused)
    drop({ ...input, accountId: 'another-account' })
    drop({ ...input, sessionID: 'another-session' })
    drop({ ...input, modelID: 'another-model' })
    drop({ ...input, agent: 'another-agent' })
    drop({ ...input, providerID: 'another-provider' })
    drop({ ...input, kind: 'compaction' })
    drop(input)
    expect(await native.authorizeAccount(scope, 'main')).toMatchObject({
      accessToken: 'sk-ant-oat01-vault-9',
      dispatch: { kind: 'direct' },
    })
    expect((await native.authorizeAccount(scope, 'main'))?.dispatch?.kind).toBe(
      'http-relay',
    )
    drop(input)
  })
  test('an undefined sticky retry choice leaves the existing session pin unchanged', async () => {
    const fixture = await local()
    await fixture.runtime.updateSettings((settings) => {
      settings.routing = { mode: 'sticky-balanced' }
    })
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    await native.drainRoutingPublications()
    const { routingPath } = await fixture.runtime.read()
    if (!routingPath) throw new Error('Missing routing path')
    const before = await readFile(routingPath, 'utf8')
    expect(
      await native.chooseAccount({
        ...scope,
        previousAccountId: 'main',
        rerouteFrom: {
          accountId: 'main',
          limit: { reason: 'provider-429', status: 429 },
        },
      }),
    ).toBeUndefined()
    await native.drainRoutingPublications()
    expect(await readFile(routingPath, 'utf8')).toBe(before)
  })
  test('vault session affinity is kept in the vault routing file and never in the local one', async () => {
    const fixture = await vault([7, 8], () => identity, {
      mode: 'sticky-balanced',
    })
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const snapshot = await fixture.runtime.read()
    if (!snapshot.routingPath)
      throw new Error('Vault mode named no routing file')
    const localRouting = getStickyRoutingStatePath(fixture.paths.legacyConfig)
    expect(snapshot.routingPath).not.toBe(localRouting)
    // Sessions are stored under hashed keys; count the assignments instead.
    const assignments = async (path: string) =>
      Object.values(
        (
          JSON.parse(await readFile(path, 'utf8')) as {
            assignments: Record<string, { accountId: string }>
          }
        ).assignments,
      ).map((assignment) => assignment.accountId)
    await native.drainRoutingPublications()
    expect(await assignments(snapshot.routingPath)).toEqual(['main'])
    expect(await exists(localRouting)).toBe(false)
    await native.resetRouting(scope.sessionID)
    await native.drainRoutingPublications()
    expect(await assignments(snapshot.routingPath)).toEqual([])
    expect(await exists(localRouting)).toBe(false)
  })
  test('replacing the vault default account re-places only its session and an unrelated fallback session pin survives unchanged', async () => {
    const fixture = await vaultWithFallback()
    const native = source(fixture.runtime, fixture.paths)
    const before = await fixture.runtime.read()
    const fallbackRoute = before.accounts.find(
      (account) => account.accountIdentity === fallbackIdentity,
    )?.id
    if (!fallbackRoute) throw new Error('Fallback vault account is missing')
    const mainSession = { ...scope, sessionID: 'ses_vault_main' }
    const fallbackSession = { ...scope, sessionID: 'ses_vault_fallback' }
    expect(await native.chooseAccount(mainSession)).toBe('main')
    // A session refused on main moves to the fallback and is pinned there.
    expect(
      await native.chooseAccount({
        ...fallbackSession,
        rerouteFrom: {
          accountId: 'main',
          limit: { reason: 'provider-overloaded', status: 529 },
        },
      }),
    ).toBe(fallbackRoute)
    const routing = before.routingPath
    if (!routing) throw new Error('Vault mode named no routing file')
    await native.drainRoutingPublications()
    const pinned = await readFile(routing, 'utf8')
    expect(JSON.parse(rawPin(pinned, mainSession.sessionID))).toMatchObject({
      accountId: 'main',
      accountIdentity: identity,
    })
    const fallbackPin = rawPin(pinned, fallbackSession.sessionID)
    expect(JSON.parse(fallbackPin)).toMatchObject({
      accountId: fallbackRoute,
      accountIdentity: fallbackIdentity,
    })

    fixture.setDefaultIdentity(changedIdentity)
    await fixture.runtime.vault.refresh()
    const after = await fixture.runtime.read()
    const replaced = after.accounts.find(
      (account) => account.accountIdentity === changedIdentity,
    )
    if (!replaced) throw new Error('Replaced default account is missing')
    const choice = await native.chooseAccount(mainSession)
    await native.drainRoutingPublications()
    const repinned = JSON.parse(
      rawPin(await readFile(routing, 'utf8'), mainSession.sessionID),
    )
    expect(repinned.accountId).toBe(choice)
    expect(repinned.accountIdentity).toBe(
      after.accounts.find((account) => account.id === choice)?.accountIdentity,
    )
    expect(repinned.accountIdentity).not.toBe(identity)
    expect(
      rawPin(await readFile(routing, 'utf8'), fallbackSession.sessionID),
    ).toBe(fallbackPin)
    expect(await native.chooseAccount(fallbackSession)).toBe(fallbackRoute)
  })
  test('local sticky routing records no account UUID in its session pins', async () => {
    const fixture = await local()
    await fixture.store.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'sticky-balanced' },
    }))
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const snapshot = await fixture.runtime.read()
    expect(snapshot.routingPath).toBe(
      join(dirname(fixture.paths.config), 'native-routing.json'),
    )
    await native.drainRoutingPublications()
    const pin = JSON.parse(
      rawPin(await readFile(snapshot.routingPath!, 'utf8'), scope.sessionID),
    )
    expect(pin.accountId).toBe('main')
    expect(pin).not.toHaveProperty('accountIdentity')
  })
  test('a vault credential that now asserts a different account UUID is refused instead of serving under the old identity', async () => {
    const fixture = await vault([7, 8], () => changedIdentity)
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    await expect(native.authorizeAccount(scope, 'main')).rejects.toThrow(
      'identity-changed',
    )
    expect(fixture.gets).toHaveLength(1)
  })
  test('a 401 retry is not offered when the newer vault version belongs to a different account UUID', async () => {
    const fixture = await vault([7, 8], (get) =>
      get <= 1 ? identity : changedIdentity,
    )
    const native = source(fixture.runtime, fixture.paths)
    expect(await native.chooseAccount(scope)).toBe('main')
    const first = await native.authorizeAccount(scope, 'main')
    if (!first) throw new Error('Vault authorization refused')
    expect(
      await native.limitFromResponse?.({
        ...context(first.provenance),
        status: 401,
        headers: new Headers({ 'request-id': 'req_vault_changed' }),
        body: async () => '{}',
      }),
    ).toBeUndefined()
    expect(fixture.gets).toHaveLength(2)
    expect(fixture.reports.map((report) => report.recordVersion)).toEqual([7])
  })
})

describe('OC2 Claude sign-in over the actual native account runtime', () => {
  test('a completed local sign-in stores an OAuth account holding only the token fields', async () => {
    const fixture = await local({
      resolveIdentity: async () => ({ accountUuid: changedIdentity }) as never,
    })
    const registration = await registeredLogin({
      isActive: () => true,
      readMode: async () => 'local',
      runtime: fixture.runtime,
      authorize: async () => ({
        url: 'https://claude.invalid/authorize',
        redirectUri: 'https://claude.invalid/callback',
        state: 'synthetic-state',
        verifier: 'synthetic-verifier',
      }),
      exchange: async () => ({
        type: 'success',
        access: 'sk-ant-oat01-signed-in',
        refresh: 'signed-in-refresh',
        expires: Date.now() + 3600_000,
      }),
    })
    const pending = await registration.authorize({})
    if (pending.mode !== 'code') throw new Error('A pasted code is required')
    await pending.callback('synthetic-code')
    const read = await fixture.store.read()
    if (read.status !== 'ready') throw new Error('Pool unreadable')
    const credentials = read.rows.map((row) => row.credential)
    const signedIn = credentials.find(
      (credential) =>
        credential?.type === 'oauth' &&
        credential.access === 'sk-ant-oat01-signed-in',
    )
    expect(signedIn).toBeDefined()
    expect(credentials.some((credential) => credential?.type !== 'oauth')).toBe(
      false,
    )
    const view = await fixture.runtime.read()
    const main = view.accounts.find((account) => account.id === 'main')
    expect(main?.type).toBe('oauth')
    expect(main?.accountIdentity).toBe(changedIdentity)
  })
  test('enrollment files make OpenCode refuse local sign-in and accept vault activation without touching local accounts', async () => {
    const fixture = await vault()
    const before = await readFile(fixture.paths.config, 'utf8')
    const input = {
      isActive: () => true,
      readMode: () => readNativeEnrollmentMode('opencode', fixture.env),
      runtime: fixture.runtime,
    }
    const local = await registeredLogin(input)
    await expect(local.authorize({})).rejects.toThrow(
      LOCAL_LOGIN_REFUSED_IN_VAULT,
    )
    const activation = await registeredLogin(
      input,
      CLAUDE_VAULT_ACTIVATION_METHOD_ID,
    )
    const pending = await activation.authorize({})
    if (pending.mode !== 'auto')
      throw new Error('Vault activation must need no user step')
    const marker = await pending.callback
    expect(String(marker.methodID)).toBe(CLAUDE_VAULT_ACTIVATION_METHOD_ID)
    expect(await readFile(fixture.paths.config, 'utf8')).toBe(before)
    const snapshot = await fixture.runtime.read()
    expect(snapshot.mode).toBe('claustrum')
    expect(snapshot.accounts.map((account) => account.source)).toEqual([
      'vault',
    ])
  })
  test('without enrollment files vault activation is refused and the local account stays served', async () => {
    const fixture = await local()
    const activation = await registeredLogin(
      {
        isActive: () => true,
        readMode: () => readNativeEnrollmentMode('opencode', fixture.env),
        runtime: fixture.runtime,
      },
      CLAUDE_VAULT_ACTIVATION_METHOD_ID,
    )
    const pending = await activation.authorize({})
    if (pending.mode !== 'auto')
      throw new Error('Vault activation must need no user step')
    await expect(pending.callback).rejects.toThrow(
      VAULT_ACTIVATION_REFUSED_LOCALLY,
    )
    const snapshot = await fixture.runtime.read()
    expect(snapshot.mode).toBe('local')
    expect(
      snapshot.accounts.find((account) => account.id === 'main')?.source,
    ).toBe('local')
  })
})

describe('OC2 vault enrollment callbacks for the claude menu', () => {
  test('disconnect ends vault enrollment so the runtime serves local accounts, without touching OpenCode sign-ins', async () => {
    const fixture = await vault()
    const dataHome = join(dirname(fixture.paths.config), 'data')
    const hostAuth = join(dataHome, 'opencode', 'auth.json')
    await mkdir(dirname(hostAuth), { recursive: true })
    const stored = JSON.stringify({
      anthropic: { type: 'api', key: 'stock-opencode-key' },
    })
    await writeFile(hostAuth, stored, { mode: 0o600 })
    const callbacks = nativeEnrollmentCallbacks({
      ...fixture.env,
      XDG_DATA_HOME: dataHome,
    })
    expect(await callbacks.readMode()).toBe('claustrum')
    expect((await fixture.runtime.read()).mode).toBe('claustrum')
    expect(await callbacks.disconnectVault()).toBe('disconnected')
    expect(await callbacks.readMode()).toBe('local')
    expect((await fixture.runtime.read()).mode).toBe('local')
    expect(await readFile(hostAuth, 'utf8')).toBe(stored)
  })
  test('disconnect without vault enrollment changes nothing and local accounts stay served', async () => {
    const fixture = await local()
    const callbacks = nativeEnrollmentCallbacks(fixture.env)
    expect(await callbacks.readMode()).toBe('local')
    expect(await callbacks.disconnectVault()).toBe('idle')
    const snapshot = await fixture.runtime.read()
    expect(snapshot.mode).toBe('local')
    expect(
      snapshot.accounts.find((account) => account.id === 'main')?.source,
    ).toBe('local')
  })
})

test('OpenCode 2 serves through a vault outage with the original receipt', async () => {
  const f = await vault()
  const native = source(f.runtime, f.paths)
  expect(await native.chooseAccount(scope)).toBe('main')
  const first = await native.authorizeAccount(scope, 'main')
  if (first?.route !== 'oauth') throw new Error('Missing vault authorization')
  f.client.getScoped = async () => {
    throw Object.assign(new Error('outage'), { code: 'ECONNREFUSED' })
  }
  const next = await native.authorizeAccount(scope, 'main')
  if (next?.route !== 'oauth')
    throw new Error('Outage refused the kept receipt')
  expect(next.accessToken).toBe(first.accessToken)
  const attempt = context(next.provenance)
  await native.limitFromResponse?.({
    ...attempt,
    status: 401,
    headers: new Headers(),
    body: async () => '{}',
  })
  await native.onAttemptEnd?.(attempt, { status: 401, outputStarted: false })
  expect(f.reports).toHaveLength(0)
  expect(f.gets).toHaveLength(1)
  await expect(native.authorizeAccount(scope, 'main')).rejects.toThrow()
})
