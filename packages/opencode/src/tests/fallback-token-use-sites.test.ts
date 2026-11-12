import { afterAll, beforeEach, describe, expect, mock, spyOn } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
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
  NativeCustodyError,
  resetCache1hState,
  resetClaudeCodeIdentityCachesForTest,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { updateNativeRuntime } from '../../../core/src/native-runtime.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import { drainSidebarWrites, getSidebarState } from '../sidebar-state'
import { CensusLockDiagnostics } from './fallback-census-lock-diagnostics'
import { migrateNativeOpencodeFixture } from './native-fixture'
import { getPluginTestHandles } from './plugin-test-handles'
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
  'OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE',
] as const

class CensusTeardownTrace {
  private readonly started = performance.now()
  private readonly events: string[] = []
  private readonly pending = new Map<string, number>()
  private failed = false
  readonly locks: CensusLockDiagnostics

  constructor(private readonly name: string) {
    this.locks = new CensusLockDiagnostics(name)
  }

  record(event: string): void {
    this.events.push(
      `${Math.round(performance.now() - this.started)}ms ${event}`,
    )
    if (this.events.length > 100) this.events.shift()
  }

  async wait<T>(
    phase: string,
    work: () => T | Promise<T>,
    failureIsTestFailure = true,
  ): Promise<T> {
    const started = performance.now()
    this.pending.set(phase, started)
    this.record(`${phase} started`)
    try {
      return await work()
    } catch (error) {
      if (failureIsTestFailure) this.failed = true
      this.record(`${phase} rejected`)
      throw error
    } finally {
      this.record(
        `${phase} settled (${Math.round(performance.now() - started)}ms)`,
      )
      this.pending.delete(phase)
    }
  }

  teardownStarted(bodySettled: boolean): void {
    this.record('lifetime afterEach started')
    unfinishedTeardowns.add(this)
    if (!bodySettled) {
      this.reportUnfinished('body still pending at teardown')
    }
  }

  complete(): void {
    unfinishedTeardowns.delete(this)
    this.record('lifetime cleanup completed')
    if (this.failed) this.report('cleanup settled after a failure')
  }

  reportUnfinished(reason: string): void {
    this.failed = true
    this.report(reason)
  }

  private report(reason: string): void {
    console.error(
      'fallback census teardown phases',
      JSON.stringify({
        test: this.name,
        reason,
        pending: [...this.pending].map(([phase, started]) => ({
          phase,
          elapsedMs: Math.round(performance.now() - started),
        })),
        events: this.events,
        lockEvidence: this.locks.snapshot(),
      }),
    )
  }
}

// A timed-out hook can skip later afterEach hooks, and Bun can exit before
// a diagnostic timer fires. A new test or afterAll with unfinished cleanup
// is already a failure; ordinary cleanup removes its trace before either.
const unfinishedTeardowns = new Set<CensusTeardownTrace>()
beforeEach(() => {
  for (const trace of unfinishedTeardowns)
    trace.reportUnfinished(
      'next test started before lifetime cleanup completed',
    )
})
afterAll(() => {
  for (const trace of unfinishedTeardowns)
    trace.reportUnfinished('file ended before lifetime cleanup completed')
})

/**
 * Everything one census body replaces or starts: the process-global fetch,
 * fixture environment, and the plugins it creates.
 *
 * Bun does not cancel a body that outlives its timeout, and once one
 * afterEach hook times out it skips every later afterEach hook for that test,
 * including the leak check in setup.ts. A hook therefore cannot be the only
 * thing that puts these globals back. The body closes its own scope before it
 * returns, and teardown's cancellation gate closes it the moment teardown
 * starts, before teardown waits for a body that is still running. Closing
 * restores the globals synchronously, before any await, and only then
 * disposes the plugins, so a slow or stuck disposal can fail only its own
 * test. Once closed, a body that is still running cannot install globals or
 * keep a new plugin alive.
 */
class CensusScope {
  readonly trace: CensusTeardownTrace
  bodySettled = false
  private readonly plugins = new Set<PluginHooks>()
  private readonly savedFetch = globalThis.fetch
  private readonly savedEnv = new Map(
    fixtureEnvKeys.map((key) => [key, process.env[key]]),
  )
  private closing: Promise<void> | undefined
  /** Set when the body starts waiting for close, so teardown need not report a close failure the body already reports. */
  joinedByBody = false

  constructor(name: string) {
    this.trace = new CensusTeardownTrace(name)
  }

  deferCleanup(label: string, cleanup: () => void | Promise<void>): void {
    lifetimes.deferCleanup(() => this.trace.wait(label, cleanup))
  }

  readonly fixtureLifetime = {
    deferCleanup: (cleanup: () => void | Promise<void>) =>
      this.deferCleanup('migration fixture removal', cleanup),
    trackDetached: (work: Promise<unknown>) =>
      lifetimes.trackDetached(
        this.trace.wait('migration detached work', () => work),
      ),
  }

  /** Call before replacing fetch or a fixture env key, and between polls. */
  assertOpen(): void {
    if (this.closing)
      throw new Error(
        'Census body was cancelled by teardown and may not continue',
      )
  }

  /** Track a plugin for disposal; a plugin created after cancellation is disposed at once. */
  own(plugin: PluginHooks): void {
    if (this.closing) {
      lifetimes.trackDetached(
        disposeAll([plugin], 'Late fallback census plugin cleanup failed'),
      )
      this.assertOpen()
    }
    this.plugins.add(plugin)
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.trace.record('restore fetch and environment started')
      this.restoreGlobals()
      this.trace.record('restore fetch and environment settled (synchronous)')
      this.closing = this.disposeOwned()
    }
    return this.closing
  }

  private restoreGlobals(): void {
    globalThis.fetch = this.savedFetch
    for (const key of fixtureEnvKeys) {
      const value = this.savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  private async disposeOwned(): Promise<void> {
    const plugins = [...this.plugins]
    this.plugins.clear()
    try {
      await this.trace.wait('plugin disposal', () =>
        disposeAll(
          plugins,
          'Fallback census plugin cleanup failed',
          this.trace,
        ),
      )
    } finally {
      await this.trace.wait('sidebar write drain', drainSidebarWrites)
      this.trace.record('cache and identity resets started')
      resetCache1hState()
      resetClaudeCodeIdentityCachesForTest()
      this.trace.record('cache and identity resets settled (synchronous)')
    }
  }
}

const lifetimes = createTestLifetimeSuite()
const censusScope = new AsyncLocalStorage<CensusScope>()

function currentScope(): CensusScope {
  const scope = censusScope.getStore()
  if (!scope) throw new Error('Census fixture used outside a census test body')
  return scope
}

// The lifetime suite registers ordinary Bun tests, which run one at a time
// within this file unless Bun is started with --concurrent; the `serial` name
// keeps the original call sites unchanged.
const test = {
  serial(name: string, body: () => unknown, timeout?: number): void {
    lifetimes.test(
      name,
      async () => {
        const scope = new CensusScope(name)
        // Teardown opens every gate as soon as its hook starts, before it
        // waits for this body; closing then restores the globals even if
        // the body is still running past its timeout. A disposal failure
        // is reported by the body or by the cleanup below, not here.
        void lifetimes.gate().wait.then(() => {
          scope.trace.teardownStarted(scope.bodySettled)
          return scope.close().catch(() => {})
        })
        // Teardown joins a disposal the body did not wait for before it
        // removes the body's files.
        scope.deferCleanup('join scope disposal', () =>
          scope.joinedByBody ? undefined : scope.close(),
        )
        try {
          return await scope.trace.wait('test body', () =>
            censusScope.run(scope, body),
          )
        } finally {
          scope.joinedByBody = true
          try {
            await scope.close()
          } finally {
            scope.bodySettled = true
            lifetimes.deferCleanup(() => scope.trace.complete())
          }
        }
      },
      timeout,
    )
  },
}

async function disposeAll(
  plugins: PluginHooks[],
  message: string,
  trace?: CensusTeardownTrace,
) {
  const results = await Promise.allSettled(
    plugins.map((plugin, index) =>
      Promise.resolve().then(() =>
        trace
          ? trace.wait(`plugin ${index + 1} dispose`, () => plugin.dispose?.())
          : plugin.dispose?.(),
      ),
    ),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      message,
    )
}

/** Claim a fresh owner-only directory for this body, removed after its plugins are disposed. */
async function startBody(prefix: string) {
  const scope = currentScope()
  scope.assertOpen()
  delete process.env.OPENCODE_AUTH_CONTENT
  const root = await mkdtemp(join(tmpdir(), prefix))
  // migrateNativeOpencodeFixture also removes the root once it accepts it;
  // this covers a body that fails before handing the root to it.
  scope.deferCleanup('body fixture removal', () =>
    rm(root, { recursive: true, force: true }),
  )
  return { root, scope }
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
    // Stop polling once teardown has cancelled this body.
    censusScope.getStore()?.assertOpen()
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
    refuseFirst?: boolean
    profile?: boolean
    captureIntervals?: boolean
    mainFirst?: boolean
    secondFallback?: boolean
    fallbackState?: 'active' | 'needs_reauth'
    /** The vault default's state as the plugin lists it after migration. */
    mainState?: 'active' | 'needs_reauth'
    fallbackEnabled?: boolean
    fallbackMode?: 'server' | 'legacy'
    recoveryToolUse?: boolean
  } = {},
) {
  const now = options.now ?? Date.now()
  let clock = now
  const fixtureNow = options.now === undefined ? Date.now : () => clock
  const canary = custodyTombstoneOAuth('anthropic').refresh
  const vault = vaultToken(site)
  const mainVault = mainVaultToken(site)
  const mainProviderAccountId = `main-provider-${site}`
  const accountId = `fallback-${site}`
  const credentialId = `oauth:anthropic:${accountId}`
  const mainCredentialId = 'oauth:anthropic'
  const nextId = `${accountId}-next`
  const nextCredentialId = `oauth:anthropic:${nextId}`
  let includeNextInRoster = options.secondFallback === true
  // Migration always sees an active default; the plugin's own listings then
  // report options.mainState.
  let mainRowState: 'active' | 'needs_reauth' = 'active'
  const intervals: IntervalRecord[] = []
  const records: OutboundRecord[] = []
  const credentialGets: Array<{ credentialId: string; isMain: boolean }> = []
  let refusalPending = options.refuseFirst ?? options.recovery === true

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
        enabled: options.fallbackEnabled ?? true,
        refresh: '',
        claustrumScopedCredentialId: credentialId,
        claustrumScopedState: options.fallbackState ?? 'active',
        anthropicAccountUuid: accountId as never,
        // A legacy quota reading names the account it was read for in
        // accountIdentity; the migration imports a reading only when that
        // matches the account's anthropicAccountUuid.
        ...(options.quotaSnapshot
          ? { quota: { ...options.quotaSnapshot, accountIdentity: accountId } }
          : {}),
      },
      ...(options.secondFallback
        ? [
            {
              id: nextId,
              type: 'oauth' as const,
              enabled: true,
              refresh: '',
              claustrumScopedCredentialId: nextCredentialId,
              claustrumScopedState: 'active' as const,
              anthropicAccountUuid: nextId as never,
              quota: { ...quota(now), accountIdentity: nextId },
            },
          ]
        : []),
    ],
  }

  const { root, scope } = await startBody(`fallback-census-${site}-`)

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
          state: mainRowState,
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
          state: options.fallbackState ?? 'active',
          recordVersion: 103,
          createdAtMs: null,
        },
        ...(includeNextInRoster
          ? [
              {
                id: nextCredentialId,
                accountId: nextId,
                categories: ['anthropic-native'],
                serves: ['anthropic'],
                providerIds: [],
                credentialType: 'oauth' as const,
                refreshAdapter: 'anthropic',
                operations: ['read'],
                state: 'active' as const,
                recordVersion: 103,
                createdAtMs: null,
              },
            ]
          : []),
      ],
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => {
      const isMain = input.credentialId === mainCredentialId
      credentialGets.push({ credentialId: input.credentialId, isMain })
      return {
        credentialId: input.credentialId,
        accountId: isMain
          ? mainProviderAccountId
          : input.credentialId === nextCredentialId
            ? nextId
            : accountId,
        material: isMain
          ? mainVault
          : input.credentialId === nextCredentialId
            ? `${vault}-next`
            : vault,
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
    lifetime: scope.fixtureLifetime,
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
  scope.assertOpen()
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
    local: { onLockEvent: scope.trace.locks.observe },
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
        source: 'vault' as const,
        credentialId: mainCredentialId,
        accountIdentity: mainProviderAccountId,
      },
      {
        id: accountId,
        source: 'vault' as const,
        credentialId,
        accountIdentity: accountId,
      },
      ...(options.secondFallback
        ? [
            {
              id: nextId,
              source: 'vault' as const,
              credentialId: nextCredentialId,
              accountIdentity: nextId,
            },
          ]
        : []),
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

  // Only the plugin's domain decisions observe the fixture clock. Filesystem
  // leases and migration continue to use wall time throughout the test.
  scope.assertOpen()
  if (options.now !== undefined) {
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

  scope.assertOpen()
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
      if (options.recoveryToolUse) {
        const model = (JSON.parse(body) as { model: string }).model
        const events = [
          [
            'message_start',
            {
              type: 'message_start',
              message: {
                id: 'msg_tool',
                model,
                usage:
                  model === 'claude-opus-5-5'
                    ? { cache_creation_input_tokens: 1000 }
                    : {},
              },
            },
          ],
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call_1',
                name: 'read',
                input: {},
              },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 1 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ]
        return Promise.resolve(
          new Response(
            events
              .map(
                ([event, data]) =>
                  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              )
              .join(''),
          ),
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
  // Recovery advances a frozen clock past quota expiry. Keep the quota GETs,
  // but do not spend real time spacing calls to the in-memory usage endpoint.
  const quotaCallPause = mock((_ms: number) => Promise.resolve())
  scope.assertOpen()
  if (options.fallbackMode)
    process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE = options.fallbackMode
  mainRowState = options.mainState ?? 'active'
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
      claustrumScopedConnect: () =>
        scope.trace.wait(
          'fixture scoped connect',
          async () => scopedClient,
          false,
        ),
      nativeLocal: { onLockEvent: scope.trace.locks.observe },
      now: fixtureNow,
      setInterval,
      clearInterval,
      ...(options.recovery ? { quotaCallPause } : {}),
    },
  )) as any
  scope.own(plugin)
  const handles = getPluginTestHandles(plugin)
  const scopedRuntime = handles.scopedRuntime
  const publish = scopedRuntime.publish.bind(scopedRuntime)
  let publication = 0
  // Advisory refusals are handled by the plugin; only body/cleanup failures
  // should trigger output from these operation timings.
  scopedRuntime.publish = (receipt, patch) =>
    scope.trace.wait(
      `vault publication ${++publication} (${Object.keys(patch).sort().join(',')})`,
      () => publish(receipt, patch),
      false,
    )
  const close = scopedRuntime.close.bind(scopedRuntime)
  scopedRuntime.close = () =>
    scope.trace.wait('vault lease close', close, false)
  const observations = scopedRuntime.quotaObservations
  const drain = observations.drain.bind(observations)
  let quotaDrain = 0
  observations.drain = () =>
    scope.trace.wait(`vault quota drain ${++quotaDrain}`, drain, false)
  const stop = handles.cacheKeepManager.stop.bind(handles.cacheKeepManager)
  handles.cacheKeepManager.stop = () => {
    scope.trace.record('CacheKeep stop started')
    try {
      return stop()
    } finally {
      scope.trace.record('CacheKeep stop settled (synchronous)')
    }
  }
  const result = await plugin.auth.loader(
    // The OpenCode auth entry exactly as the migration left it in host auth.
    async () =>
      JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).anthropic,
    { models: {} },
  )
  await getPluginTestHandles(plugin).fallbackRefreshReady

  return {
    accountId,
    nextId,
    paths: fixture.paths,
    credentialGets,
    scopedClient,
    intervals,
    plugin,
    records,
    result,
    quotaCallPause,
    storage,
    discoverNextFallback() {
      includeNextInRoster = true
    },
    refuseNext() {
      refusalPending = true
    },
  }
}

test.serial(
  'vault discovery polls a new fallback without a periodic quota tick',
  async () => {
    const fixture = await createFixture('request', {
      quotaEnabled: true,
      quotaSnapshot: quota(Date.now()),
      captureIntervals: true,
    })
    const usage = () =>
      fixture.records.filter((record) =>
        record.url.includes('/api/oauth/usage'),
      )
    expect(usage()).toEqual([])
    const rosterTick = fixture.intervals.find(
      (interval) => interval.ms === 2000,
    )
    expect(rosterTick).toBeDefined()
    fixture.discoverNextFallback()
    rosterTick?.callback()
    await waitFor(() => usage().length > 0, 'New vault fallback was not polled')
    expect(usage().map((record) => record.authorization)).toEqual([
      `Bearer ${vaultToken('request')}-next`,
    ])
  },
)

test.serial(
  'handled advisory refusals keep teardown diagnostics silent',
  async () => {
    const trace = new CensusTeardownTrace('handled advisory refusal')
    const output = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const refusal = new Error('expected advisory refusal')
      await expect(
        trace.wait('vault publication', () => Promise.reject(refusal), false),
      ).rejects.toBe(refusal)
      trace.complete()
      expect(output).not.toHaveBeenCalled()
    } finally {
      output.mockRestore()
    }
  },
)

describe('vault-served fallback outbound token census', () => {
  test.serial(
    'an advanced plugin clock leaves native-runtime leases on wall time',
    async () => {
      const wallNow = Date.now
      const fixture = await createFixture('request', {
        now: wallNow() + 55 * 60_000,
      })
      const { storageId } = JSON.parse(
        await readFile(fixture.paths.runtime, 'utf8'),
      )
      const leasePath = `${fixture.paths.runtime}.native-runtime.lock`
      const started = wallNow()
      let expiresAt = 0
      await updateNativeRuntime(
        fixture.paths.runtime,
        storageId,
        (state) => state,
        {
          beforeRename: async () => {
            expiresAt = JSON.parse(await readFile(leasePath, 'utf8')).expiresAt
          },
        },
      )
      expect(expiresAt).toBeGreaterThanOrEqual(started + 10_000)
      expect(expiresAt).toBeLessThanOrEqual(wallNow() + 10_000)
      expect(Date.now).toBe(wallNow)
      await expect(readFile(leasePath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

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
    await getPluginTestHandles(fixture.plugin).fallbackRefreshReady
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
    await getPluginTestHandles(fixture.plugin).primeManager.tick()

    const fallbackRecords = fixture.records.filter(
      (record) => record.authorization === `Bearer ${vaultToken('prime')}`,
    )
    expectOnlyVaultToken(fallbackRecords, 'prime')
    expect(
      fallbackRecords.some((record) => record.url.includes('/v1/messages')),
      JSON.stringify({
        fallbackRecords,
        stats: getPluginTestHandles(fixture.plugin).primeManager.stats(
          fixture.storage,
        ),
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

  for (const fallbackMode of ['server', 'legacy'] as const)
    for (const cleanReset of [false, true])
      test.serial(
        `recovery ${cleanReset ? 'clean-source reset' : 'backoff and model reset'} counts tool responses and warms the source only near expiry (${fallbackMode})`,
        async () => {
          const now = Date.now()
          const fixture = await createFixture('recovery', {
            now,
            quotaEnabled: true,
            quotaSnapshot: quota(now, 98),
            recovery: true,
            refuseFirst: false,
            fallbackMode,
            recoveryToolUse: true,
            captureIntervals: true,
          })
          fixture.records.length = 0
          const request = {
            method: 'POST',
            headers: { 'x-session-affinity': 'recovery-census' },
            body: JSON.stringify({
              model: 'claude-opus-5-5',
              max_tokens: 128_000,
              stream: true,
              system: [{ type: 'text', text: 'stable system' }],
              messages: [{ role: 'user', content: 'hello' }],
            }),
          }
          const manager = getPluginTestHandles(fixture.plugin).cacheKeepManager
          const immediateWarm = mock(manager.prewarmNow.bind(manager))
          manager.prewarmNow = immediateWarm
          const messages = () =>
            fixture.records
              .filter((record) => record.url.includes('/v1/messages'))
              .map((record) => JSON.parse(record.body))
          const send = async (model: string, refusal = false) => {
            if (refusal) fixture.refuseNext()
            const response = await fixture.result.fetch(MESSAGES_URL, request)
            if (refusal) await expect(response.text()).rejects.toThrow()
            else expect(await response.text()).toContain('tool_use')
            expect(
              messages()
                .filter((body) => body.max_tokens !== 0)
                .at(-1)?.model,
            ).toBe(model)
            expect(immediateWarm).not.toHaveBeenCalled()
            // Warms go to the live Opus 4.8 prefix, or to the source model's
            // kept prefix near its expiry. A source warm never carries the
            // server-side fallback opt-in.
            expect(
              messages()
                .filter((body) => body.max_tokens === 0)
                .every(
                  (body) =>
                    body.model === 'claude-opus-4-8' ||
                    (body.model === 'claude-opus-5-5' &&
                      body.fallbacks === undefined),
                ),
            ).toBe(true)
          }
          // Recovery keeps a source prefix only after a completed request has
          // reported cache usage, before the refused request starts the round.
          await send('claude-opus-5-5')
          for (const responses of [10]) {
            await send('claude-opus-5-5', true)
            for (let index = 0; index < responses; index++) {
              await send('claude-opus-4-8')
              if (responses === 10 && index === 0) {
                expect(
                  messages().filter((body) => body.max_tokens === 0),
                ).toHaveLength(0)
                ;(
                  fixture.intervals as IntervalRecord[] & {
                    clock: (now: number) => void
                  }
                ).clock(now + 55 * 60_000)
                await manager.tick()
                // Both caches are near expiry: the live Opus 4.8 prefix and
                // the source model's prefix kept when the round started.
                expect(
                  messages()
                    .filter((body) => body.max_tokens === 0)
                    .map((body) => body.model)
                    .sort(),
                ).toEqual(['claude-opus-4-8', 'claude-opus-5-5'])
              }
            }
            await send('claude-opus-5-5')
            await send('claude-opus-5-5')
          }
          // Two source tool responses have completed; eight more clear the backoff.
          if (cleanReset)
            for (let index = 0; index < 8; index++)
              await send('claude-opus-5-5')
          await send('claude-opus-5-5', true)
          await drainSidebarWrites()
          expect(
            (await getSidebarState()).fableRecoveries?.find(
              (recovery) => recovery.sessionId === 'recovery-census',
            )?.remaining,
          ).toBe(cleanReset ? 10 : 20)
          await send('claude-opus-4-8')
          if (!cleanReset) {
            const changedModel = {
              ...request,
              body: JSON.stringify({
                ...JSON.parse(request.body),
                model: 'claude-sonnet-4-6',
              }),
            }
            await (
              await fixture.result.fetch(MESSAGES_URL, changedModel)
            ).text()
            await send('claude-opus-5-5')
            await send('claude-opus-5-5', true)
            await drainSidebarWrites()
            expect(
              (await getSidebarState()).fableRecoveries?.find(
                (recovery) => recovery.sessionId === 'recovery-census',
              )?.remaining,
            ).toBe(10)
            await send('claude-opus-4-8')
            await fixture.plugin.event({
              event: {
                type: 'session.deleted',
                properties: { sessionID: 'recovery-census' },
              },
            })
            await send('claude-opus-5-5')
          }
          expect(fixture.quotaCallPause).toHaveBeenCalledWith(1_000)
        },
      )

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
    currentScope().assertOpen()
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
      currentScope().assertOpen()
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
      currentScope().assertOpen()
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
      await getPluginTestHandles(fixture.plugin).primeManager.tick()
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
    currentScope().assertOpen()
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
    await getPluginTestHandles(fixture.plugin).primeManager.tick()
    expect(sent).toEqual([
      'Bearer scoped-prime-quota-v103',
      'Bearer scoped-prime-quota-v104',
    ])
    expect(reports).toEqual([104])
  },
)

async function serveOrdered(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  model = 'claude-opus-4-8',
) {
  fixture.records.length = 0
  const response = await fixture.result.fetch(MESSAGES_URL, {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  await response.text()
  return fixture.records.filter((record) => record.url.includes('/v1/messages'))
}

describe('vault fallback eligibility', () => {
  test.serial(
    'ordered routing skips a vault fallback below minimumRemaining',
    async () => {
      const now = Date.now()
      const low = quota(now)
      low.five_hour.remainingPercent = 0.5
      low.five_hour.usedPercent = 99.5
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: low,
        secondFallback: true,
      })
      const sent = await serveOrdered(fixture)
      expect(sent.map((record) => record.authorization)).toEqual([
        `Bearer ${vaultToken('request')}-next`,
      ])
    },
  )

  test.serial(
    'ordered routing skips a scoped-exhausted vault fallback and serves the next',
    async () => {
      const now = Date.now()
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: quota(now, 0),
        secondFallback: true,
      })
      const sent = await serveOrdered(fixture, 'claude-fable-5')
      expect(sent.map((record) => record.authorization)).toEqual([
        `Bearer ${vaultToken('request')}-next`,
      ])
    },
  )

  test.serial(
    'model quota exhausted during vault authorization skips to next fallback',
    async () => {
      const now = Date.now()
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: quota(now),
        secondFallback: true,
      })
      const runtime = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
        vault: { connect: async () => fixture.scopedClient },
      })
      currentScope().deferCleanup('native runtime close', () => runtime.close())
      const getScoped = fixture.scopedClient.getScoped
      let changed = false
      fixture.scopedClient.getScoped = async (input) => {
        if (
          !changed &&
          input.credentialId === `oauth:anthropic:${fixture.accountId}`
        ) {
          changed = true
          await runtime.fetchQuota(fixture.accountId, (async () =>
            Response.json({
              five_hour: { utilization: 10 },
              seven_day: { utilization: 10 },
              limits: [
                {
                  kind: 'weekly_scoped',
                  group: 'weekly',
                  percent: 100,
                  scope: { model: { display_name: 'Fable' } },
                },
              ],
            })) as unknown as typeof fetch)
          await runtime.drainQuotaPublications()
        }
        return getScoped(input)
      }
      const sent = await serveOrdered(fixture, 'claude-fable-5')
      expect(changed).toBe(true)
      expect(sent.map((record) => record.authorization)).toEqual([
        `Bearer ${vaultToken('request')}-next`,
      ])
    },
  )

  test.serial(
    'ordered routing propagates vault authorization failure',
    async () => {
      const now = Date.now()
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: quota(now),
        secondFallback: true,
      })
      fixture.scopedClient.getScoped = async () => {
        throw new NativeCustodyError('invalid-token')
      }
      await expect(serveOrdered(fixture)).rejects.toMatchObject({
        code: 'unavailable',
      })
      expect(
        fixture.records.filter((record) => record.url.includes('/v1/messages')),
      ).toEqual([])
    },
  )

  test.serial(
    'enabled needs-sign-in vault fallback stays in sidebar but is not routed',
    async () => {
      const now = Date.now()
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: quota(now),
        secondFallback: true,
        fallbackState: 'needs_reauth',
      })
      const sent = await serveOrdered(fixture)
      expect(sent.map((record) => record.authorization)).toEqual([
        `Bearer ${vaultToken('request')}-next`,
      ])
      await drainSidebarWrites()
      expect(
        fixture.credentialGets.some(
          (get) => get.credentialId === `oauth:anthropic:${fixture.accountId}`,
        ),
      ).toBe(false)
      const state = await getSidebarState()
      expect(
        state.fallbacks.find((row) => row.id === fixture.accountId),
      ).toMatchObject({
        enabled: true,
        stateLine: 'needs sign-in in the vault',
        quotaDated: true,
        quota: { five_hour: { remainingPercent: 90 } },
      })
    },
  )

  test.serial(
    'a vault default that needs sign-in shows once, as main, in the sidebar',
    async () => {
      const now = Date.now()
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: quota(now),
        mainState: 'needs_reauth',
      })
      await serveOrdered(fixture)
      await drainSidebarWrites()
      const state = await getSidebarState()
      expect(state.main.stateLine).toBe('needs sign-in in the vault')
      // The default credential must not also appear as a vault fallback row.
      expect(state.fallbacks.map((row) => row.id)).toEqual([fixture.accountId])
    },
  )

  test.serial(
    'user-disabled vault fallback shows turned off with dated quota',
    async () => {
      const now = Date.now()
      const fixture = await createFixture('request', {
        now,
        quotaEnabled: true,
        quotaSnapshot: quota(now),
        secondFallback: true,
        fallbackEnabled: false,
      })
      const sent = await serveOrdered(fixture)
      expect(sent.map((record) => record.authorization)).toEqual([
        `Bearer ${vaultToken('request')}-next`,
      ])
      await drainSidebarWrites()
      expect(
        (await getSidebarState()).fallbacks.find(
          (row) => row.id === fixture.accountId,
        ),
      ).toMatchObject({
        enabled: false,
        stateLine: 'turned off',
        quotaDated: true,
        quota: { five_hour: { remainingPercent: 90 } },
      })
    },
  )
})
