import { expect, spyOn } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  type NativeAccountSnapshot,
  resetClaudeCodeIdentityCachesForTest,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { createOpencodeClient, type Provider } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { getPluginTestHandles } from './plugin-test-handles'

/*
 * Fallback quota sweeps decide which accounts are due from a pool snapshot,
 * then poll each due account's usage endpoint. Two properties are tested here
 * through a migrated native pool, the real plugin and its real request path,
 * with only the HTTP transport replaced:
 *
 * 1. With a killswitch enabled, fallback-first routing polls a due fallback
 *    before it chooses a route. Model dispatch waits for that usage GET, and
 *    the route follows the reading it returned. A fallback whose reading is
 *    still current is not polled again.
 *
 * 2. Sweeps run one after another. A sweep that starts while another sweep's
 *    usage GET is still outstanding reads the pool only after that reading is
 *    stored, so it cannot poll the same account again from an older snapshot.
 *
 * Usage GETs can be held open by the test. A held GET is released by the test
 * or, if the body ends first, by the body's lifetime as it starts closing.
 */

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
type PluginFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
type AuthLoader = NonNullable<NonNullable<PluginHooks['auth']>['loader']>
type HostAuth = Awaited<ReturnType<Parameters<AuthLoader>[0]>>
type NativeRuntime = ReturnType<typeof Core.createNativeAccountRuntime>

const MAIN_UUID = '00000000-0000-4000-8000-00000000c001'
const FALLBACK_UUID = '00000000-0000-4000-8000-00000000d001'
const FALLBACK_ID = 'sweep-fallback'
const MAIN_ACCESS = 'sk-ant-oat01-sweep-main-access'
const MAIN_REFRESH = 'sk-ant-ort01-sweep-main-refresh'
const FALLBACK_ACCESS = 'sk-ant-oat01-sweep-fallback-access'
const FALLBACK_REFRESH = 'sk-ant-ort01-sweep-fallback-refresh'
const MAIN_BEARER = `Bearer ${MAIN_ACCESS}`
const FALLBACK_BEARER = `Bearer ${FALLBACK_ACCESS}`
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

const accountForBearer = new Map([
  [MAIN_BEARER, MAIN_UUID],
  [FALLBACK_BEARER, FALLBACK_UUID],
])

// Each test body restores every environment variable it sets.
const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
] as const

const provider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

/** One outbound usage or model request, in the order it reached the transport. */
type Dispatch = { kind: 'usage' | 'messages'; authorization: string }

/** A usage reading with both standard windows used by the given percentages. */
function usageReading(fiveHourUsed: number, sevenDayUsed: number) {
  const now = Date.now()
  return {
    five_hour: {
      utilization: fiveHourUsed,
      resets_at: new Date(now + 60 * 60_000).toISOString(),
    },
    seven_day: {
      utilization: sevenDayUsed,
      resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString(),
    },
  }
}

/** Main reports 90% remaining, above its 5% and 10% minimums. */
const MAIN_READING = () => usageReading(10, 10)

type BodyOptions = {
  /**
   * quota.enabled. When false, the startup sweep returns without polling, so
   * only the killswitch's own preflight polls the fallback.
   */
  quotaEnabled: boolean
  killswitchEnabled?: boolean
  /** Percent used that each fallback usage GET reports on both windows. */
  fallbackUsed: number
  fallbackScopedUsed?: number
  /** Zero-based indexes of the fallback usage GETs the test holds open. */
  holdFallbackUsage?: number[]
}

/**
 * Extract the fallback's quota fields from the account snapshot. An account
 * without a stored quota returns undefined.
 */
function fallbackQuota(snapshot: NativeAccountSnapshot) {
  const quota = snapshot.accounts.find(
    (account) => account.id === FALLBACK_ID,
  )?.quota
  return quota
    ? {
        accountIdentity: quota.accountIdentity,
        fiveHourRemaining: quota.five_hour?.remainingPercent,
        sevenDayRemaining: quota.seven_day?.remainingPercent,
        checkedAt: quota.checkedAt,
      }
    : undefined
}

/**
 * A promise plus the function that resolves it. The fake transport resolves
 * one when a fallback usage GET reaches it, and the body awaits that.
 */
function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = () => done()
  })
  return { promise, resolve }
}

/**
 * Create a migrated local pool with main and fallback OAuth accounts bound
 * to synthetic UUIDs, initially without stored quota. Requests try fallback
 * first. Both accounts require at least 5% five-hour and 10% seven-day quota
 * remaining. Disable proactive token refresh so the background sweep reaches
 * its quota poll without first exchanging credentials.
 */
async function migratePool(options: BodyOptions) {
  const root = await mkdtemp(join(tmpdir(), 'quota-sweep-'))
  // The fixture removes the root once it accepts it; this covers a body that
  // fails before that.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      main: {
        type: 'opencode',
        provider: 'anthropic',
        // The matching token fingerprint ties the stored profile's UUID to
        // main's login. The mocked bootstrap verifies that same UUID.
        profile: {
          tier: 'default_claude_max_20x',
          orgType: 'claude_max',
          checkedAt: now,
          providerAccountUuid: MAIN_UUID,
          tokenFingerprint: tokenFingerprint(MAIN_ACCESS),
        },
      },
      fallbackOn: [401, 403, 429],
      routing: { mode: 'fallback-first' },
      refresh: { enabled: false },
      quota: { enabled: options.quotaEnabled, failClosedOnUnknownQuota: false },
      killswitch: {
        enabled: options.killswitchEnabled ?? true,
        main: { five_hour: 5, seven_day: 10 },
      },
      claudeCache: { enabled: false },
      accounts: [
        {
          id: FALLBACK_ID,
          label: FALLBACK_ID,
          type: 'oauth',
          enabled: true,
          access: FALLBACK_ACCESS,
          refresh: FALLBACK_REFRESH,
          expires: now + 8 * 60 * 60_000,
          anthropicAccountUuid: FALLBACK_UUID,
        },
      ],
    },
    hostAuth: {
      anthropic: {
        type: 'oauth',
        access: MAIN_ACCESS,
        refresh: MAIN_REFRESH,
        expires: now + 8 * 60 * 60_000,
      },
    },
  })
  return { fixture, now }
}

/**
 * Pool reads made by the plugin's native runtime. `capture` returns the reads
 * started while its callback runs. While `holding` is set, each new read
 * still runs at once, so its snapshot reflects the pool at the moment it was
 * called, but its result is delivered only after `releaseHeld()`.
 */
type ReadControl = {
  capture(run: () => void): Promise<NativeAccountSnapshot>[]
  holding: boolean
  /**
   * One promise per read started while `holding` was set. Each settles when
   * the pool read itself finishes, which can be well before the plugin is
   * given that read's result.
   */
  held: Promise<unknown>[]
  releaseHeld(): void
}

/**
 * Migrate the pool, install the transport, and load the plugin and its auth
 * loader. Startup begins the plugin's first fallback sweep; this returns
 * without waiting for it.
 */
async function startBody(options: BodyOptions) {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  let stopPlugin: (() => Promise<void>) | undefined
  // Runs after the body and its tracked work. The plugin has normally been
  // stopped already through its gate; stopping again is a no-op.
  lifetimes.deferCleanup(async () => {
    try {
      await stopPlugin?.()
    } finally {
      try {
        await drainSidebarWrites()
      } finally {
        globalThis.fetch = savedFetch
        for (const key of envKeys) {
          const value = savedEnv.get(key)
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        resetClaudeCodeIdentityCachesForTest()
      }
    }
  })
  const { fixture, now } = await migratePool(options)
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  process.env.XDG_DATA_HOME = join(fixture.root, 'synthetic-data')
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()

  const dispatches: Dispatch[] = []
  const holds = new Set(options.holdFallbackUsage ?? [])
  const usageArrivals = new Map<number, ReturnType<typeof signal>>()
  const usageReleases = new Map<number, () => void>()
  const arrivalFor = (index: number) => {
    let arrival = usageArrivals.get(index)
    if (!arrival) {
      arrival = signal()
      usageArrivals.set(index, arrival)
    }
    return arrival
  }
  let fallbackUsageCount = 0
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      const authorization = headers.get('authorization') ?? ''
      const account = accountForBearer.get(authorization)
      if (url.includes('/claude_cli/bootstrap'))
        return account
          ? Response.json({ oauth_account: { account_uuid: account } })
          : new Response('unknown token', { status: 401 })
      if (url.includes('/api/oauth/usage')) {
        dispatches.push({ kind: 'usage', authorization })
        if (!account) return new Response('unknown token', { status: 401 })
        if (authorization === FALLBACK_BEARER) {
          const index = fallbackUsageCount++
          if (holds.has(index)) {
            // The lifetime opens this gate when it starts closing, so a body
            // that fails while the GET is held cannot leave it pending.
            const gate = lifetimes.gate()
            usageReleases.set(index, gate.open)
            arrivalFor(index).resolve()
            await gate.wait
          } else arrivalFor(index).resolve()
          return Response.json({
            ...usageReading(options.fallbackUsed, options.fallbackUsed),
            ...(options.fallbackScopedUsed !== undefined
              ? {
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent: options.fallbackScopedUsed,
                      scope: { model: { display_name: 'Fable' } },
                    },
                  ],
                }
              : {}),
          })
        }
        return Response.json(MAIN_READING())
      }
      if (url.includes('/v1/messages')) {
        dispatches.push({ kind: 'messages', authorization })
        return Response.json({
          id: 'msg_quota_sweep',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      return new Response('unexpected request', { status: 599 })
    },
    { preconnect: savedFetch.preconnect },
  )

  const factory = Core.createNativeAccountRuntime
  // The test reads public account views through its own runtime, which the
  // spy below does not wrap and which stays open until the body has settled.
  const observer = factory({ paths: fixture.paths, host: 'opencode' })
  lifetimes.deferCleanup(() => observer.close())
  const read = () => observer.read()
  let capturing: Promise<NativeAccountSnapshot>[] | undefined
  const heldDeliveries: Array<() => void> = []
  const reads: ReadControl = {
    capture(run) {
      const started: Promise<NativeAccountSnapshot>[] = []
      capturing = started
      try {
        run()
      } finally {
        capturing = undefined
      }
      return started
    },
    holding: false,
    held: [],
    releaseHeld() {
      for (const deliver of heldDeliveries.splice(0)) deliver()
    },
  }
  let servingRuntime: NativeRuntime | undefined
  const spy = spyOn(Core, 'createNativeAccountRuntime').mockImplementation(
    (runtimeOptions) => {
      const runtime: NativeRuntime = factory(runtimeOptions)
      servingRuntime = runtime
      const readPool = runtime.read.bind(runtime)
      runtime.read = () => {
        const result = readPool()
        capturing?.push(result)
        if (!reads.holding) return result
        reads.held.push(result.catch(() => {}))
        // A body that ends without releasing still delivers on teardown.
        const gate = lifetimes.gate()
        heldDeliveries.push(gate.open)
        return result.then(async (snapshot) => {
          await gate.wait
          return snapshot
        })
      }
      return runtime
    },
  )
  lifetimes.deferCleanup(() => spy.mockRestore())

  // Plugin-local interval hooks: the plugin registers its background sweep
  // here instead of with the process timers, so the test can run one tick.
  const intervals: Array<{ run: () => void; ms: number }> = []
  const timerHandle = { unref() {}, ref() {} }
  const runtimeOverrides = {
    scopedRosterPollIntervalMs: 0,
    cacheKeepAggregateRefreshIntervalMs: 0,
    setInterval: ((run: () => void, ms: number) => {
      intervals.push({ run, ms })
      return timerHandle
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as typeof clearInterval,
  }

  // Stop the plugin when the lifetime starts closing, before it waits for the
  // body, so a body blocked on plugin work is released.
  const stopping = lifetimes.gate()
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'quota-sweep-fixture',
        worktree: fixture.root,
        time: { created: now },
      },
      directory: fixture.root,
      worktree: fixture.root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    runtimeOverrides,
  )
  let disposal: Promise<void> | undefined
  const stop = () => {
    disposal ??= creation.then(async (created) => {
      await created.dispose?.()
    })
    return disposal
  }
  stopPlugin = stop
  lifetimes.trackDetached(stopping.wait.then(stop))
  const plugin = await creation
  // Only the background fallback sweep is registered while the plugin is
  // created; its period is one minute plus up to one minute of jitter.
  const sweepTicks = intervals.filter(
    (interval) => interval.ms >= 60_000 && interval.ms <= 120_000,
  )
  if (intervals.length !== 1 || sweepTicks.length !== 1)
    throw new Error(
      `Expected one background sweep interval, saw ${JSON.stringify(intervals.map((interval) => interval.ms))}`,
    )
  const backgroundSweep = sweepTicks[0]?.run
  if (!backgroundSweep) throw new Error('Missing background sweep interval')
  const startupSweep = getPluginTestHandles(plugin).fallbackRefreshReady
  if (!startupSweep) throw new Error('Plugin exposed no startup sweep')
  const loader: AuthLoader | undefined = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  // OpenCode hands the loader its stored Anthropic login. Pass the entry the
  // fixture's migration left in the host auth file, as OpenCode would.
  const loaded = await loader(async () => {
    const stored: { anthropic: HostAuth } = JSON.parse(
      await readFile(fixture.hostAuthPath, 'utf8'),
    )
    return stored.anthropic
  }, provider)
  const handler = loaded.fetch
  if (typeof handler !== 'function')
    throw new Error('Plugin did not install its request handler')
  const send: PluginFetch = async (input, init) => {
    const response: unknown = await handler(input, init)
    if (!(response instanceof Response))
      throw new Error('Plugin request handler did not return a Response')
    return response
  }
  return {
    dispatches,
    read,
    reads,
    stop,
    paths: fixture.paths,
    servingView: () => {
      if (!servingRuntime) throw new Error('Missing serving runtime')
      return servingRuntime.read()
    },
    startupSweep,
    backgroundSweep,
    async seedQuota(quota: Core.OAuthQuotaSnapshot) {
      // The plugin owns another store. Close this fixture writer so its
      // accepted quota is on disk before that independent reader runs.
      const seed = factory({ paths: fixture.paths, host: 'opencode' })
      try {
        const admitted = await seed.authorizeLocal(FALLBACK_ID)
        if (admitted.status !== 'usable')
          throw new Error(
            `Fixture credential was not admitted: ${admitted.status}`,
          )
        const saved = await seed.publishLocal(admitted.subject, {
          quota: { ...quota, accountIdentity: FALLBACK_UUID },
        })
        if (!saved) throw new Error('Fixture quota publication was refused')
        await seed.updateSettings((settings) => ({
          ...settings,
          quota: {
            enabled: true,
            minimumRemaining: { five_hour: 5, seven_day: 10 },
            failClosedOnUnknownQuota: false,
          },
        }))
      } finally {
        await seed.close()
      }
    },
    /** Resolves when the given fallback usage GET reaches the transport. */
    fallbackUsageArrived: (index: number) => arrivalFor(index).promise,
    /** Let a held fallback usage GET return its reading. */
    releaseFallbackUsage(index: number) {
      const release = usageReleases.get(index)
      if (!release) throw new Error(`Fallback usage GET ${index} is not held`)
      release()
    },
    /**
     * Send one replayable model request through the plugin. The body awaits
     * the result and sees any failure. Teardown also waits for the request to
     * settle: a body that fails while a usage GET is held leaves its request
     * running until the plugin is stopped, and that late refusal is not a
     * second test failure.
     */
    request(model = 'claude-sonnet-4-6') {
      const result = (async () => {
        const response = await send(MESSAGES_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        })
        return { status: response.status, body: await response.text() }
      })()
      lifetimes.trackDetached(result.catch(() => {}))
      return result
    },
  }
}

/**
 * The parts of a request sequence that main-routed tests compare: how many
 * usage GETs the fallback received, what was sent first, which logins reached
 * the model endpoint, and whether main's quota was checked. How many times
 * main itself is polled on its own route is not part of these properties.
 */
function mainRouteSummary(dispatches: Dispatch[]) {
  return {
    fallbackUsageGets: dispatches.filter(
      (dispatch) =>
        dispatch.kind === 'usage' && dispatch.authorization === FALLBACK_BEARER,
    ).length,
    firstDispatch: dispatches[0],
    modelDispatches: dispatches
      .filter((dispatch) => dispatch.kind === 'messages')
      .map((dispatch) => dispatch.authorization),
    mainPolled: dispatches.some(
      (dispatch) =>
        dispatch.kind === 'usage' && dispatch.authorization === MAIN_BEARER,
    ),
  }
}

const usage = (authorization: string): Dispatch => ({
  kind: 'usage',
  authorization,
})
const messages = (authorization: string): Dispatch => ({
  kind: 'messages',
  authorization,
})

function storedQuota(remainingPercent: number, checkedAt: number) {
  const window = {
    checkedAt,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  }
  return { checkedAt, five_hour: { ...window }, seven_day: { ...window } }
}

test('ordered routing refreshes stale fallback quota with killswitch off before choosing', async () => {
  const body = await startBody({
    quotaEnabled: false,
    killswitchEnabled: false,
    fallbackUsed: 10,
  })
  await body.startupSweep
  await body.seedQuota(storedQuota(0, Date.now() - 24 * 60 * 60_000))

  expect((await body.request()).status).toBe(200)
  expect(body.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
})

test('ordered routing skips a stale healthy fallback after its refreshed quota falls below the floor with killswitch off', async () => {
  const body = await startBody({
    quotaEnabled: false,
    killswitchEnabled: false,
    fallbackUsed: 100,
  })
  await body.startupSweep
  await body.seedQuota(storedQuota(90, Date.now() - 24 * 60 * 60_000))

  expect((await body.request()).status).toBe(200)
  expect(mainRouteSummary(body.dispatches)).toEqual({
    fallbackUsageGets: 1,
    firstDispatch: usage(FALLBACK_BEARER),
    modelDispatches: [MAIN_BEARER],
    mainPolled: true,
  })
})

test('ordered routing reuses fresh fallback quota with killswitch off without polling', async () => {
  const body = await startBody({
    quotaEnabled: false,
    killswitchEnabled: false,
    fallbackUsed: 10,
  })
  await body.startupSweep
  await body.seedQuota(storedQuota(90, Date.now()))

  expect((await body.request()).status).toBe(200)
  expect(body.dispatches).toEqual([messages(FALLBACK_BEARER)])
})

test('ordered routing refreshes the requested model scoped window with killswitch off', async () => {
  const body = await startBody({
    quotaEnabled: false,
    killswitchEnabled: false,
    fallbackUsed: 10,
    fallbackScopedUsed: 10,
  })
  await body.startupSweep
  const now = Date.now()
  await body.seedQuota({
    ...storedQuota(90, now),
    scoped: [
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: now - 24 * 60 * 60_000,
      },
    ],
  })

  expect((await body.request('claude-fable-5-1')).status).toBe(200)
  expect(body.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
  const snapshot = await body.servingView()
  expect(
    snapshot.accounts.find((account) => account.id === FALLBACK_ID)?.quota
      ?.scoped?.[0]?.remainingPercent,
  ).toBe(90)
})

test('concurrent ordered requests share one due fallback poll with killswitch off', async () => {
  const body = await startBody({
    quotaEnabled: false,
    killswitchEnabled: false,
    fallbackUsed: 10,
    holdFallbackUsage: [0],
  })
  await body.startupSweep
  await body.seedQuota(storedQuota(0, Date.now() - 24 * 60 * 60_000))

  const requests = Promise.all([body.request(), body.request()])
  // A missing preflight must fail the dispatch assertion rather than hang
  // waiting for a usage GET that never starts.
  await Promise.race([body.fallbackUsageArrived(0), requests])
  expect(body.dispatches).toEqual([usage(FALLBACK_BEARER)])
  body.releaseFallbackUsage(0)
  expect((await requests).map((response) => response.status)).toEqual([
    200, 200,
  ])
  expect(body.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
})

test('fallback-first holds dispatch until the due fallback usage GET returns, then serves the fallback from that reading', async () => {
  // quota.enabled=false: the startup sweep polls nothing, so the fallback
  // still has no reading when the request arrives and only the killswitch
  // preflight can supply one.
  const body = await startBody({
    quotaEnabled: false,
    fallbackUsed: 10,
    holdFallbackUsage: [0],
  })
  await body.startupSweep
  expect(body.dispatches).toEqual([])
  expect(fallbackQuota(await body.read())).toBeUndefined()

  const pending = body.request()
  await body.fallbackUsageArrived(0)
  const heldAt = Date.now()
  // The fallback's usage GET is the first thing the request sends. Nothing
  // has gone to the model endpoint or polled main while it is outstanding,
  // and no reading has been stored yet.
  expect(body.dispatches).toEqual([usage(FALLBACK_BEARER)])
  expect(fallbackQuota(await body.read())).toBeUndefined()
  body.releaseFallbackUsage(0)
  const response = await pending

  // The reading (90% left on both windows, above the 5% and 10% floors) lets
  // fallback-first serve with the fallback's login. Main is never polled.
  expect(response.status).toBe(200)
  expect(body.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
  const stored = fallbackQuota(await body.read())
  expect(stored).toMatchObject({
    accountIdentity: FALLBACK_UUID,
    fiveHourRemaining: 90,
    sevenDayRemaining: 90,
  })
  expect(stored?.checkedAt).toBeGreaterThanOrEqual(heldAt)
})

test('fallback-first learns from the due fallback usage GET that it is below its floor before polling or serving main', async () => {
  const body = await startBody({
    quotaEnabled: false,
    fallbackUsed: 98,
    holdFallbackUsage: [0],
  })
  await body.startupSweep
  expect(body.dispatches).toEqual([])
  expect(fallbackQuota(await body.read())).toBeUndefined()

  const pending = body.request()
  await body.fallbackUsageArrived(0)
  const heldAt = Date.now()
  expect(body.dispatches).toEqual([usage(FALLBACK_BEARER)])
  body.releaseFallbackUsage(0)
  const response = await pending

  // 2% left is below the fallback's 5% five-hour floor, so the request goes
  // to main. Main's quota is checked only after the fallback's reading.
  expect(response.status).toBe(200)
  expect(mainRouteSummary(body.dispatches)).toEqual({
    fallbackUsageGets: 1,
    firstDispatch: usage(FALLBACK_BEARER),
    modelDispatches: [MAIN_BEARER],
    mainPolled: true,
  })
  const stored = fallbackQuota(await body.read())
  expect(stored).toMatchObject({
    accountIdentity: FALLBACK_UUID,
    fiveHourRemaining: 2,
    sevenDayRemaining: 2,
  })
  expect(stored?.checkedAt).toBeGreaterThanOrEqual(heldAt)
})

test('a fallback whose startup reading is still current is served without another usage GET', async () => {
  // quota.enabled=true: startup polls the fallback once. The request reuses
  // that reading because it is still current.
  const body = await startBody({ quotaEnabled: true, fallbackUsed: 10 })
  await body.startupSweep
  expect(body.dispatches).toEqual([usage(FALLBACK_BEARER)])
  const startup = fallbackQuota(await body.read())
  expect(startup).toMatchObject({
    accountIdentity: FALLBACK_UUID,
    fiveHourRemaining: 90,
    sevenDayRemaining: 90,
  })

  const response = await body.request()

  expect(response.status).toBe(200)
  expect(body.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
  expect(fallbackQuota(await body.read())).toEqual(startup)
})

test('a background sweep started during the held startup usage GET reads the pool after that reading is stored and polls the account once', async () => {
  // The fallback reports 2% left, below its 5% floor, so the closing request
  // is served by main and its main quota check runs after any fallback poll
  // already waiting for the quota client.
  const body = await startBody({
    quotaEnabled: true,
    fallbackUsed: 98,
    holdFallbackUsage: [0],
  })
  await body.fallbackUsageArrived(0)
  expect(body.dispatches).toEqual([usage(FALLBACK_BEARER)])
  expect(fallbackQuota(await body.read())).toBeUndefined()

  // Run one background tick. Its first pool read starts synchronously inside
  // the tick; once that read is delivered, the tick hands its sweep to the
  // sweep queue before this body resumes. Pool reads started from then on are
  // held: each still reads the pool immediately, but its result is delivered
  // only after the startup sweep has finished.
  const kickoff = body.reads.capture(body.backgroundSweep)
  expect(kickoff.length).toBeGreaterThan(0)
  body.reads.holding = true
  await Promise.all(kickoff)
  body.reads.holding = false
  // Every read the background sweep started so far has read the pool while
  // the startup GET was still outstanding.
  await Promise.all(body.reads.held)

  body.releaseFallbackUsage(0)
  await body.startupSweep
  const stored = fallbackQuota(await body.read())
  expect(stored).toMatchObject({
    accountIdentity: FALLBACK_UUID,
    fiveHourRemaining: 2,
    sevenDayRemaining: 2,
  })
  body.reads.releaseHeld()

  // The request's own sweeps queue behind the background sweep, so by the
  // time the request polls main, the background sweep has made its decision.
  const response = await body.request()

  expect(response.status).toBe(200)
  // One usage GET for the fallback: the background sweep saw the stored
  // reading and did not poll the account again.
  expect(mainRouteSummary(body.dispatches)).toEqual({
    fallbackUsageGets: 1,
    firstDispatch: usage(FALLBACK_BEARER),
    modelDispatches: [MAIN_BEARER],
    mainPolled: true,
  })
  expect(fallbackQuota(await body.read())).toEqual(stored)
})

test('simultaneous requests during the held startup usage GET wait for it and are both served from its one reading', async () => {
  const body = await startBody({
    quotaEnabled: true,
    fallbackUsed: 10,
    holdFallbackUsage: [0],
  })
  await body.fallbackUsageArrived(0)
  expect(fallbackQuota(await body.read())).toBeUndefined()

  // Both requests start while the startup GET is held. Each may join that
  // poll, wait behind it, or start after it, depending on how far it got;
  // in every case it must route from the one reading the GET returns.
  const both = Promise.all([body.request(), body.request()])
  body.releaseFallbackUsage(0)
  const responses = await both

  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(body.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
  expect(fallbackQuota(await body.read())).toMatchObject({
    accountIdentity: FALLBACK_UUID,
    fiveHourRemaining: 90,
    sevenDayRemaining: 90,
  })
})

test('quota poll serves its reading while runtime sync is held and dispose drains publication', async () => {
  const f = await startBody({ quotaEnabled: false, fallbackUsed: 20 })
  await f.startupSweep
  const held = lifetimes.gate()
  // A publication may never reach the spy. Release its arrival wait on teardown
  // so a timed-out body can settle before the lifetime restores fetch and files.
  const arrived = lifetimes.gate()
  const stallDeadline = () =>
    new Promise<string>((resolve) =>
      setTimeout(() => resolve('blocked on sync'), 250),
    )
  const realOpen = fsPromises.open
  let intercepted = false
  const openSpy = spyOn(fsPromises, 'open').mockImplementation(
    async (path, flags, mode) => {
      const file = await realOpen(path, flags, mode)
      if (String(path).startsWith(`${f.paths.runtime}.native-runtime.`)) {
        const sync = file.sync.bind(file)
        file.sync = async () => {
          const staged = JSON.parse(await readFile(path, 'utf8'))
          if (
            !intercepted &&
            staged.accounts[FALLBACK_ID]?.quotaErrorClearedAt
          ) {
            intercepted = true
            arrived.open()
            await held.wait
          }
          return sync()
        }
      }
      return file
    },
  )
  lifetimes.deferCleanup(() => openSpy.mockRestore())
  const request = f.request()
  await arrived.wait
  // Teardown also opens this gate after a timeout and stops the plugin.
  // Do not continue into its account reads or requests without an interception.
  if (!intercepted) return
  const result = await Promise.race([
    request.then(() => 'served'),
    stallDeadline(),
  ])
  expect(result).toBe('served')
  expect(f.dispatches).toEqual([
    usage(FALLBACK_BEARER),
    messages(FALLBACK_BEARER),
  ])
  expect(fallbackQuota(await f.servingView())).toMatchObject({
    fiveHourRemaining: 80,
    sevenDayRemaining: 80,
  })
  expect((await f.request()).status).toBe(200)
  expect(f.dispatches.filter((entry) => entry.kind === 'usage')).toEqual([
    usage(FALLBACK_BEARER),
  ])
  let disposed = false
  const disposal = f.stop().then(() => {
    disposed = true
  })
  lifetimes.trackDetached(disposal)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(disposed).toBe(false)
  held.open()
  await disposal
  expect(disposed).toBe(true)
  expect(fallbackQuota(await f.read())).toMatchObject({ fiveHourRemaining: 80 })
})
