import { afterEach, describe, expect, mock } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  CACHE_KEEP_TICK_MS,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  getLogLevel,
  type LogTestRecord,
  type NativeCustodyClient,
  resetCache1hState,
  resetClaudeCodeIdentityCachesForTest,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import { drainSidebarWrites } from '../sidebar-state'
import { migrateNativeOpencodeFixture } from './native-fixture'
import { extractUrl, MESSAGES_URL } from './test-fetch'

type Site =
  | 'request'
  | 'quota'
  | 'prime'
  | 'cachekeep'
  | 'main-cachekeep'
  | 'recovery'
  | 'profile'

type OutboundRecord = {
  url: string
  authorization: string
  bodyHasCanary: boolean
  headersHaveCanary: boolean
  body: string
}

type IntervalRecord = { callback: () => unknown; ms: number }

type PluginHooks = { dispose?: () => Promise<void> | void }

// Every environment variable a test body or the migration fixture may set.
// Each body saves and restores all of them, so no path leaks into the next
// test.
const fixtureEnvKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
] as const

const livePlugins = new Set<Set<PluginHooks>>()
// Registered before the lifetime suite's own afterEach: dispose every plugin
// (its timers and vault client) before that hook waits for a possibly
// still-running body and removes the body's files.
afterEach(async () => {
  const plugins = [...livePlugins].flatMap((owned) => {
    const current = [...owned]
    owned.clear()
    return current
  })
  await disposeAll(plugins, 'Fallback census plugin cancellation failed')
})
const lifetimes = createTestLifetimeSuite()
// The lifetime suite registers ordinary Bun tests, which run one at a time
// within this file unless Bun is started with --concurrent; the `serial` name
// keeps the original call sites unchanged.
const test = { serial: lifetimes.test }

async function disposeAll(plugins: PluginHooks[], message: string) {
  const results = await Promise.allSettled(
    plugins.map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      message,
    )
}

/**
 * Claim a fresh owner-only directory for this body. Teardown first disposes
 * the body's plugins and waits for sidebar writes, then restores fetch, the
 * clock, the environment and the process-wide caches, and only then removes
 * the directory.
 */
async function startBody(prefix: string) {
  const savedFetch = globalThis.fetch
  const savedNow = Date.now
  const savedEnv = new Map(fixtureEnvKeys.map((key) => [key, process.env[key]]))
  const plugins = new Set<PluginHooks>()
  livePlugins.add(plugins)
  lifetimes.deferCleanup(async () => {
    const remaining = [...plugins]
    plugins.clear()
    livePlugins.delete(plugins)
    try {
      await disposeAll(remaining, 'Fallback census plugin cleanup failed')
    } finally {
      await drainSidebarWrites()
      globalThis.fetch = savedFetch
      Date.now = savedNow
      for (const key of fixtureEnvKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetCache1hState()
      resetClaudeCodeIdentityCachesForTest()
    }
  })
  delete process.env.OPENCODE_AUTH_CONTENT
  const root = await mkdtemp(join(tmpdir(), prefix))
  // migrateNativeOpencodeFixture also removes the root once it accepts it;
  // this covers a body that fails before handing the root to it.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return { root, plugins }
}

function quota(now: number, fableRemaining = 90) {
  return {
    checkedAt: now,
    five_hour: {
      usedPercent: 10,
      remainingPercent: 90,
      checkedAt: now,
      resetsAt: new Date(now + 60 * 60_000).toISOString(),
    },
    seven_day: {
      usedPercent: 10,
      remainingPercent: 90,
      checkedAt: now,
      resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    },
    scoped: [
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 100 - fableRemaining,
        remainingPercent: fableRemaining,
        checkedAt: now,
        resetsAt: new Date(now + 24 * 60 * 60_000).toISOString(),
      },
    ],
  }
}

function vaultToken(site: Site) {
  return `sk-ant-oat01-vault-${site}`
}

function mainVaultToken(site: Site) {
  return `sk-ant-oat01-vault-main-${site}`
}

function expectOnlyVaultToken(
  records: OutboundRecord[],
  site: Site,
  diagnostics?: unknown,
  expectedToken = vaultToken(site),
) {
  expect(records.length, `${site}: no outbound requests`).toBeGreaterThan(0)
  for (const record of records) {
    expect(
      record.authorization,
      `${site}: ${record.url}: ${JSON.stringify(diagnostics)}`,
    ).toBe(`Bearer ${expectedToken}`)
    expect(record.headersHaveCanary, `${site}: canary in headers`).toBe(false)
    expect(record.bodyHasCanary, `${site}: canary in body`).toBe(false)
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 50,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(message)
}

async function createFixture(
  site: Site,
  options: {
    now?: number
    quotaEnabled?: boolean
    quotaSnapshot?: ReturnType<typeof quota>
    prime?: boolean
    primeMainDue?: boolean
    cachekeep?: boolean
    recovery?: boolean
    profile?: boolean
    captureIntervals?: boolean
    mainFirst?: boolean
  } = {},
) {
  const now = options.now ?? Date.now()
  const canary = custodyTombstoneOAuth('anthropic').refresh
  const vault = vaultToken(site)
  const mainVault = mainVaultToken(site)
  const mainProviderAccountId = `main-provider-${site}`
  const accountId = `fallback-${site}`
  const credentialId = `oauth:anthropic:${accountId}`
  const mainCredentialId = 'oauth:anthropic'
  const intervals: IntervalRecord[] = []
  const records: OutboundRecord[] = []
  const credentialGets: Array<{ credentialId: string; isMain: boolean }> = []
  let refusalPending = options.recovery === true

  const storage: AccountStorage = {
    version: 1,
    mainAccountId: `main-slot-${site}`,
    main: {
      type: 'opencode',
      provider: 'anthropic',
      profile: {
        tier: 'default_claude_max_5x',
        orgType: 'claude_team',
        checkedAt: now,
        providerAccountUuid: mainProviderAccountId as never,
      },
    },
    fallbackOn: [401, 403, 429],
    routing: {
      mode: options.recovery
        ? 'sticky-balanced'
        : options.mainFirst
          ? 'main-first'
          : 'fallback-first',
    },
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 30,
    },
    quota: options.quotaEnabled
      ? {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          ...(options.recovery || options.prime
            ? {
                mainQuota: {
                  ...quota(now, options.recovery ? 0 : 90),
                  ...(options.primeMainDue
                    ? {
                        five_hour: {
                          ...quota(now).five_hour,
                          resetsAt: new Date(now - 120_000).toISOString(),
                        },
                      }
                    : {}),
                  accountIdentity: mainProviderAccountId,
                },
                mainQuotaCheckedAt: now,
              }
            : {}),
        }
      : { enabled: false, failClosedOnUnknownQuota: false },
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: mainCredentialId,
        accountId: mainProviderAccountId as never,
        state: 'active',
      },
    },
    ...(options.prime ? { prime: { enabled: true } } : {}),
    ...(options.cachekeep || options.recovery
      ? {
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: true, always: true, subagents: true },
        }
      : {}),
    accounts: [
      {
        id: accountId,
        label: accountId,
        type: 'oauth',
        enabled: true,
        refresh: '',
        claustrumScopedCredentialId: credentialId,
        claustrumScopedState: 'active',
        anthropicAccountUuid: accountId as never,
        // A legacy quota reading names the account it was read for in
        // accountIdentity; the migration imports a reading only when that
        // matches the account's anthropicAccountUuid.
        ...(options.quotaSnapshot
          ? { quota: { ...options.quotaSnapshot, accountIdentity: accountId } }
          : {}),
      },
    ],
  }

  const { root, plugins } = await startBody(`fallback-census-${site}-`)

  const scopedClient: NativeCustodyClient = {
    listScoped: async () => ({
      view: `census-${site}`,
      rows: [
        {
          id: mainCredentialId,
          accountId: mainProviderAccountId,
          categories: ['anthropic-native'],
          serves: ['anthropic'],
          providerIds: [],
          credentialType: 'oauth',
          refreshAdapter: 'anthropic',
          operations: ['read'],
          state: 'active' as const,
          recordVersion: 103,
          createdAtMs: null,
        },
        {
          id: credentialId,
          accountId,
          categories: ['anthropic-native'],
          serves: ['anthropic'],
          providerIds: [],
          credentialType: 'oauth',
          refreshAdapter: 'anthropic',
          operations: ['read'],
          state: 'active' as const,
          recordVersion: 103,
          createdAtMs: null,
        },
      ],
    }),
    getScoped: async (input) => {
      const isMain = input.credentialId === mainCredentialId
      credentialGets.push({ credentialId: input.credentialId, isMain })
      return {
        credentialId: input.credentialId,
        accountId: isMain ? mainProviderAccountId : accountId,
        material: isMain ? mainVault : vault,
        expiresAtMs: Date.now() + 12 * 60 * 60_000,
        recordVersion: 103,
      }
    },
    reportAuthFailureScoped: async () => {},
    close() {},
  }

  // Import the legacy seat through the real offline migration. Discovery
  // lists the same vault rows the plugin serves from but refuses credential
  // reads, so every recorded credential read happened while serving.
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: storage as unknown as Record<string, unknown>,
    hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
    custody: {
      connect: async () => ({
        listScoped: (token) => scopedClient.listScoped(token),
        getScoped: async () => {
          throw new Error('Migration discovery must not read credentials')
        },
        reportAuthFailureScoped: async () => {
          throw new Error('Migration discovery must not report credentials')
        },
        close() {},
      }),
      enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
    },
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  if (options.profile)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  else process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  // Both vault accounts are served from the migrated native pool, and the
  // legacy quota readings the prime and recovery tests rely on were imported.
  const migrated = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    const snapshot = await migrated.read()
    expect(
      snapshot.accounts.map(
        ({ id, source, credentialId, accountIdentity }) => ({
          id,
          source,
          credentialId,
          accountIdentity,
        }),
      ),
    ).toEqual([
      {
        id: 'main',
        source: 'vault',
        credentialId: mainCredentialId,
        accountIdentity: mainProviderAccountId,
      },
      {
        id: accountId,
        source: 'vault',
        credentialId,
        accountIdentity: accountId,
      },
    ])
    const byId = new Map(snapshot.accounts.map((a) => [a.id, a]))
    if (options.quotaSnapshot)
      expect(byId.get(accountId)?.quota?.checkedAt).toBe(
        options.quotaSnapshot.checkedAt,
      )
    if (storage.quota?.mainQuota)
      expect(byId.get('main')?.quota?.accountIdentity).toBe(
        mainProviderAccountId,
      )
  } finally {
    migrated.close()
  }

  // Freeze the clock only after migration, so the migration journal and
  // locks see real time and only the plugin observes the test clock.
  if (options.now !== undefined) {
    let clock = now
    Date.now = mock(() => clock) as unknown as typeof Date.now
    Object.defineProperty(intervals, 'clock', {
      value: (next: number) => {
        clock = next
      },
    })
  }

  const refusalSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const successSse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok","model":"claude-opus-4-8","usage":{}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')

  globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
    const url = extractUrl(input as string | URL | Request)
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? init.body : ''
    records.push({
      url,
      authorization: headers.get('authorization') ?? '',
      body,
      bodyHasCanary: body.includes(canary),
      headersHaveCanary: [...headers.values()].some((value) =>
        value.includes(canary),
      ),
    })
    if (url.includes('/claude_cli/bootstrap')) {
      return Promise.resolve(
        Response.json({
          oauth_account: {
            account_uuid:
              headers.get('authorization') === `Bearer ${mainVault}`
                ? mainProviderAccountId
                : accountId,
          },
        }),
      )
    }
    if (url.includes('/api/oauth/profile')) {
      return Promise.resolve(
        Response.json({
          organization: {
            organization_type: 'claude_team',
            rate_limit_tier: 'default_claude_max_5x',
          },
        }),
      )
    }
    if (url.includes('/api/oauth/usage')) {
      return Promise.resolve(
        Response.json({
          five_hour: {
            utilization: 10,
            resets_at: new Date(
              now - (options.prime ? 120_000 : 1_000),
            ).toISOString(),
          },
          seven_day: { utilization: 10 },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent:
                options.recovery &&
                headers.get('authorization') === `Bearer ${mainVault}`
                  ? 100
                  : 10,
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        }),
      )
    }
    if (url.includes('/v1/messages')) {
      const parsed = body ? (JSON.parse(body) as { max_tokens?: number }) : {}
      if (parsed.max_tokens === 0) {
        return Promise.resolve(
          Response.json({ usage: { input_tokens: 1, output_tokens: 0 } }),
        )
      }
      if (refusalPending) {
        refusalPending = false
        return Promise.resolve(new Response(refusalSse, { status: 200 }))
      }
      if (options.prime) {
        return Promise.resolve(
          Response.json({ usage: { input_tokens: 20, output_tokens: 1 } }),
        )
      }
      return Promise.resolve(new Response(successSse, { status: 200 }))
    }
    return Promise.resolve(new Response('unexpected', { status: 599 }))
  }) as unknown as typeof fetch

  const setInterval = options.captureIntervals
    ? (mock((callback: () => unknown, ms: number) => {
        intervals.push({ callback, ms })
        return { unref() {} } as unknown as ReturnType<
          typeof globalThis.setInterval
        >
      }) as unknown as typeof globalThis.setInterval)
    : (mock(
        () =>
          ({ unref() {} }) as unknown as ReturnType<
            typeof globalThis.setInterval
          >,
      ) as unknown as typeof globalThis.setInterval)
  const clearInterval = mock(
    () => {},
  ) as unknown as typeof globalThis.clearInterval
  const plugin = (await (
    AnthropicAuthPlugin as unknown as (
      context: unknown,
      runtime: unknown,
    ) => Promise<any>
  )(
    {
      client: {
        auth: { set: mock(() => Promise.resolve()) },
        session: { promptAsync: mock(() => Promise.resolve()) },
      },
    },
    {
      claustrumScopedConnect: async () => scopedClient,
      setInterval,
      clearInterval,
    },
  )) as any
  plugins.add(plugin)
  const result = await plugin.auth.loader(
    // The OpenCode auth entry exactly as the migration left it in host auth.
    async () =>
      JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).anthropic,
    { models: {} },
  )
  await plugin.__fallbackRefreshReady

  return {
    accountId,
    credentialGets,
    scopedClient,
    intervals,
    plugin,
    records,
    result,
    storage,
  }
}

describe('vault-served fallback outbound token census', () => {
  test.serial('request and lane-start sends', async () => {
    const fixture = await createFixture('request')
    fixture.records.length = 0
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await fixture.result.fetch(MESSAGES_URL, { method: 'POST', body })
    ).text()
    await (
      await fixture.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { [LANE_START_REQUEST_HEADER]: '1' },
        body,
      })
    ).text()

    const messageRecords = fixture.records.filter((record) =>
      record.url.includes('/v1/messages'),
    )
    expectOnlyVaultToken(messageRecords, 'request', fixture.credentialGets)
    expect(messageRecords).toHaveLength(2)
  })

  test.serial('fallback-manager quota poll', async () => {
    const fixture = await createFixture('quota', { quotaEnabled: true })
    await fixture.plugin.__fallbackRefreshReady
    const usage = fixture.records.filter((record) =>
      record.url.includes('/api/oauth/usage'),
    )

    expectOnlyVaultToken(usage, 'quota')
  })

  test.serial('prime tick', async () => {
    const now = Date.now() - 60_000
    const dueQuota = quota(now)
    dueQuota.five_hour.resetsAt = new Date(now - 120_000).toISOString()
    const fixture = await createFixture('prime', {
      now,
      quotaEnabled: true,
      quotaSnapshot: dueQuota,
      prime: true,
    })
    fixture.records.length = 0
    await fixture.plugin.__primeManager.tick()

    const fallbackRecords = fixture.records.filter(
      (record) => record.authorization === `Bearer ${vaultToken('prime')}`,
    )
    expectOnlyVaultToken(fallbackRecords, 'prime')
    expect(
      fallbackRecords.some((record) => record.url.includes('/v1/messages')),
      JSON.stringify({
        fallbackRecords,
        stats: fixture.plugin.__primeManager.stats(fixture.storage),
      }),
    ).toBe(true)
  })

  test.serial('CacheKeep prewarm', async () => {
    const now = 1_000
    const fixture = await createFixture('cachekeep', {
      now,
      cachekeep: true,
      captureIntervals: true,
    })
    fixture.records.length = 0
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await fixture.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'cachekeep-census' },
        body,
      })
    ).text()
    resetClaudeCodeIdentityCachesForTest()
    fixture.records.length = 0
    ;(
      fixture.intervals as IntervalRecord[] & { clock: (now: number) => void }
    ).clock(now + 55 * 60_000)
    const cacheKeepTick = fixture.intervals.find(
      (interval) => interval.ms === CACHE_KEEP_TICK_MS,
    )
    if (!cacheKeepTick) throw new Error('missing CacheKeep interval')
    cacheKeepTick.callback()
    await waitFor(
      () =>
        fixture.records.some((record) => {
          if (!record.url.includes('/v1/messages')) return false
          return (
            (JSON.parse(record.body) as { max_tokens?: number }).max_tokens ===
            0
          )
        }),
      'CacheKeep prewarm did not run',
    )

    expectOnlyVaultToken(fixture.records, 'cachekeep')
    const bootstrap = fixture.records.filter((record) =>
      record.url.includes('/claude_cli/bootstrap'),
    )
    // Native signing uses the identity the vault already verified for this
    // receipt, so a prewarm never sends a bootstrap lookup with any token.
    expect(bootstrap, JSON.stringify(fixture.credentialGets)).toEqual([])
  })

  test.serial(
    'CacheKeep prewarms a vault-served main without reading the tombstone',
    async () => {
      const now = 1_000
      const fixture = await createFixture('main-cachekeep', {
        now,
        cachekeep: true,
        captureIntervals: true,
        mainFirst: true,
      })
      fixture.records.length = 0
      const body = JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      })
      await (
        await fixture.result.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': 'main-cachekeep-census' },
          body,
        })
      ).text()
      resetClaudeCodeIdentityCachesForTest()
      fixture.records.length = 0
      ;(
        fixture.intervals as IntervalRecord[] & { clock: (now: number) => void }
      ).clock(now + 55 * 60_000)
      const cacheKeepTick = fixture.intervals.find(
        (interval) => interval.ms === CACHE_KEEP_TICK_MS,
      )
      if (!cacheKeepTick) throw new Error('missing CacheKeep interval')
      cacheKeepTick.callback()
      await waitFor(
        () =>
          fixture.records.some((record) => {
            if (!record.url.includes('/v1/messages')) return false
            return (
              (JSON.parse(record.body) as { max_tokens?: number })
                .max_tokens === 0
            )
          }),
        'main CacheKeep prewarm did not run',
      )

      expectOnlyVaultToken(
        fixture.records,
        'main-cachekeep',
        fixture.credentialGets,
        mainVaultToken('main-cachekeep'),
      )
    },
  )

  test.serial('recovery source-model prewarm', async () => {
    // Recovery and ordinary CacheKeep prewarms intentionally share prepareHeaders.
    const now = Date.now()
    const fixture = await createFixture('recovery', {
      now,
      quotaEnabled: true,
      quotaSnapshot: quota(now, 98),
      recovery: true,
    })
    fixture.records.length = 0
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'recovery-census' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    const refused = await fixture.result.fetch(MESSAGES_URL, request)
    await expect(refused.text()).rejects.toThrow()
    await (await fixture.result.fetch(MESSAGES_URL, request)).text()
    try {
      await waitFor(
        () =>
          fixture.records.some((record) => {
            if (!record.url.includes('/v1/messages')) return false
            return (
              (JSON.parse(record.body) as { max_tokens?: number })
                .max_tokens === 0
            )
          }),
        'recovery source-model prewarm did not run',
      )
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}: ${JSON.stringify({ records: fixture.records, credentialGets: fixture.credentialGets })}`,
      )
    }

    expectOnlyVaultToken(
      fixture.records.filter((record) => record.url.includes('/v1/messages')),
      'recovery',
      fixture.credentialGets,
    )
  })

  test.serial('profile hydration', async () => {
    const fixture = await createFixture('profile', { profile: true })
    await waitFor(
      () =>
        fixture.records.some((record) =>
          record.url.includes('/api/oauth/profile'),
        ),
      'fallback profile hydration did not run',
    )
    const profiles = fixture.records.filter((record) =>
      record.url.includes('/api/oauth/profile'),
    )

    expectOnlyVaultToken(profiles, 'profile')
  })
})

describe('scoped maintenance rotation recovery', () => {
  async function checkCacheKeepRotation(finalStatus: 200 | 401) {
    const now = 1_000
    const fixture = await createFixture('main-cachekeep', {
      now,
      cachekeep: true,
      captureIntervals: true,
      mainFirst: true,
    })
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await fixture.result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': `cachekeep-rotated-${finalStatus}` },
        body,
      })
    ).text()
    resetClaudeCodeIdentityCachesForTest()
    const reports: number[] = []
    const sent: string[] = []
    let version = 103
    const originalGet = fixture.scopedClient.getScoped.bind(
      fixture.scopedClient,
    )
    fixture.scopedClient.getScoped = async (input) => {
      const receipt = await originalGet(input)
      return input.credentialId === 'oauth:anthropic'
        ? {
            ...receipt,
            material: `scoped-cachekeep-v${version}`,
            recordVersion: version,
          }
        : receipt
    }
    fixture.scopedClient.reportAuthFailureScoped = async ({
      recordVersion,
    }) => {
      reports.push(recordVersion)
    }
    const originalRequest = globalThis.fetch
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      const requestBody = typeof init?.body === 'string' ? init.body : ''
      if (
        extractUrl(input as string | URL | Request).includes('/v1/messages') &&
        (JSON.parse(requestBody) as { max_tokens?: number }).max_tokens === 0
      ) {
        sent.push(authorization)
        if (authorization === 'Bearer scoped-cachekeep-v103') {
          version = 104
          return Promise.resolve(
            new Response('rotated token rejected', { status: 401 }),
          )
        }
        if (finalStatus === 401)
          return Promise.resolve(
            new Response('current token rejected', { status: 401 }),
          )
      }
      return originalRequest(input as Parameters<typeof fetch>[0], init)
    }) as unknown as typeof fetch
    ;(
      fixture.intervals as IntervalRecord[] & { clock: (now: number) => void }
    ).clock(now + 55 * 60_000)
    const interval = fixture.intervals.find(
      (candidate) => candidate.ms === CACHE_KEEP_TICK_MS,
    )
    if (!interval) throw new Error('CacheKeep interval missing')
    interval.callback()
    await waitFor(
      () => sent.length >= 2,
      'rotated CacheKeep prewarm was not replayed',
    )
    await waitFor(
      () => reports.length >= (finalStatus === 401 ? 1 : 0),
      'CacheKeep final 401 was not reported',
    )
    expect(sent).toEqual([
      'Bearer scoped-cachekeep-v103',
      'Bearer scoped-cachekeep-v104',
    ])
    expect(reports).toEqual(finalStatus === 401 ? [104] : [])
  }

  test.serial(
    'CacheKeep reauthorizes one rotated prewarm without reporting the obsolete receipt',
    () => checkCacheKeepRotation(200),
  )
  test.serial(
    'CacheKeep reports only the newly served version if the replay also receives 401',
    () => checkCacheKeepRotation(401),
  )

  test.serial(
    'CacheKeep records reauthorize-failed and reports the served version when re-authorization throws',
    async () => {
      const now = 1_000
      const fixture = await createFixture('main-cachekeep', {
        now,
        cachekeep: true,
        captureIntervals: true,
        mainFirst: true,
      })
      await (
        await fixture.result.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': 'cachekeep-reauthorize-failed' },
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            stream: true,
            system: [
              {
                type: 'text',
                text: 'stable',
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages: [{ role: 'user', content: 'hello' }],
          }),
        })
      ).text()
      resetClaudeCodeIdentityCachesForTest()
      const reports: number[] = []
      const sent: string[] = []
      let failReauthorize = false
      const originalGet = fixture.scopedClient.getScoped.bind(
        fixture.scopedClient,
      )
      fixture.scopedClient.getScoped = async (input) => {
        if (failReauthorize && input.credentialId === 'oauth:anthropic') {
          throw new Error('vault unavailable')
        }
        const receipt = await originalGet(input)
        return input.credentialId === 'oauth:anthropic'
          ? {
              ...receipt,
              material: 'scoped-cachekeep-v103',
              recordVersion: 103,
            }
          : receipt
      }
      fixture.scopedClient.reportAuthFailureScoped = async ({
        recordVersion,
      }) => {
        reports.push(recordVersion)
      }
      const originalRequest = globalThis.fetch
      globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
        const requestBody = typeof init?.body === 'string' ? init.body : ''
        if (
          extractUrl(input as string | URL | Request).includes(
            '/v1/messages',
          ) &&
          (JSON.parse(requestBody) as { max_tokens?: number }).max_tokens === 0
        ) {
          sent.push(new Headers(init?.headers).get('authorization') ?? '')
          failReauthorize = true
          return Promise.resolve(
            new Response('token rejected', { status: 401 }),
          )
        }
        return originalRequest(input as Parameters<typeof fetch>[0], init)
      }) as unknown as typeof fetch

      const records: LogTestRecord[] = []
      const previousLevel = getLogLevel()
      setLogLevel('debug')
      __setLogTestSink((record) => records.push(record))
      try {
        ;(
          fixture.intervals as IntervalRecord[] & {
            clock: (now: number) => void
          }
        ).clock(now + 55 * 60_000)
        const interval = fixture.intervals.find(
          (candidate) => candidate.ms === CACHE_KEEP_TICK_MS,
        )
        if (!interval) throw new Error('CacheKeep interval missing')
        interval.callback()
        await waitFor(
          () => reports.length >= 1,
          'CacheKeep 401 was not reported after re-authorization failed',
        )
      } finally {
        __setLogTestSink(null)
        setLogLevel(previousLevel)
      }

      expect(sent).toEqual(['Bearer scoped-cachekeep-v103'])
      expect(reports).toEqual([103])
      expect(
        records
          .filter((record) => record.message === 'scoped 401 re-authorized')
          .map((record) => record.payload),
      ).toContainEqual(
        expect.objectContaining({
          site: 'cachekeep',
          servedVersion: 103,
          currentVersion: null,
          retry: false,
          reason: 'reauthorize-failed',
        }),
      )
    },
  )

  test.serial(
    'Prime fires only once after in-flight rotation and reports the final rejected version',
    async () => {
      const now = Date.now() - 60_000
      const dueQuota = quota(now)
      dueQuota.five_hour.resetsAt = new Date(now - 120_000).toISOString()
      const fixture = await createFixture('prime', {
        now,
        quotaEnabled: true,
        quotaSnapshot: dueQuota,
        prime: true,
      })
      const reports: number[] = []
      const sent: string[] = []
      let version = 103
      const originalGet = fixture.scopedClient.getScoped.bind(
        fixture.scopedClient,
      )
      fixture.scopedClient.getScoped = async (input) => {
        const receipt = await originalGet(input)
        return input.credentialId === `oauth:anthropic:${fixture.accountId}`
          ? {
              ...receipt,
              material: `scoped-prime-v${version}`,
              recordVersion: version,
            }
          : receipt
      }
      fixture.scopedClient.reportAuthFailureScoped = async ({
        recordVersion,
      }) => {
        reports.push(recordVersion)
      }
      const originalRequest = globalThis.fetch
      globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
        const url = extractUrl(input as string | URL | Request)
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        const requestBody = typeof init?.body === 'string' ? init.body : ''
        if (
          url.includes('/v1/messages') &&
          requestBody &&
          (JSON.parse(requestBody) as { max_tokens?: number }).max_tokens ===
            1 &&
          authorization.startsWith('Bearer scoped-prime-v')
        ) {
          sent.push(authorization)
          if (authorization === 'Bearer scoped-prime-v103') {
            version = 104
            return Promise.resolve(
              new Response('rotated token rejected', { status: 401 }),
            )
          }
          return Promise.resolve(
            new Response('latest token rejected', { status: 401 }),
          )
        }
        return originalRequest(input as Parameters<typeof fetch>[0], init)
      }) as unknown as typeof fetch
      await fixture.plugin.__primeManager.tick()
      expect(sent).toEqual([
        'Bearer scoped-prime-v103',
        'Bearer scoped-prime-v104',
      ])
      expect(reports).toEqual([104])
    },
  )
})

test.serial(
  'Prime quota preflight reports the actual scoped version used after a second 401',
  async () => {
    const now = Date.now() - 60_000
    const dueQuota = quota(now)
    dueQuota.five_hour.resetsAt = new Date(now - 120_000).toISOString()
    const fixture = await createFixture('prime', {
      now,
      quotaEnabled: true,
      quotaSnapshot: dueQuota,
      prime: true,
      primeMainDue: true,
    })
    const sent: string[] = []
    const reports: number[] = []
    let version = 103
    const originalGet = fixture.scopedClient.getScoped.bind(
      fixture.scopedClient,
    )
    fixture.scopedClient.getScoped = async (input) => {
      const receipt = await originalGet(input)
      return input.credentialId === 'oauth:anthropic'
        ? {
            ...receipt,
            material: `scoped-prime-quota-v${version}`,
            recordVersion: version,
          }
        : receipt
    }
    fixture.scopedClient.reportAuthFailureScoped = async ({
      recordVersion,
    }) => {
      reports.push(recordVersion)
    }
    const originalRequest = globalThis.fetch
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const url = extractUrl(input as string | URL | Request)
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      if (
        url.includes('/api/oauth/usage') &&
        authorization.startsWith('Bearer scoped-prime-quota-v')
      ) {
        sent.push(authorization)
        version = 104
        return Promise.resolve(
          new Response('quota token rejected', { status: 401 }),
        )
      }
      return originalRequest(input as Parameters<typeof fetch>[0], init)
    }) as unknown as typeof fetch
    await fixture.plugin.__primeManager.tick()
    expect(sent).toEqual([
      'Bearer scoped-prime-quota-v103',
      'Bearer scoped-prime-quota-v104',
    ])
    expect(reports).toEqual([104])
  },
)
