import { expect } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  getLogLevel,
  type NativeAccountRuntimeOptions,
  type NativeCustodyClient,
  type NativePoolPaths,
  type ProviderAccountUuid,
  resetClaudeCodeIdentityCachesForTest,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { withLock } from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'

import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites, getSidebarState } from '../sidebar-state.ts'
import {
  migrateNativeOpencodeFixture,
  type NativeOpencodeFixtureInput,
} from './native-fixture.ts'
import { getPluginTestHandles } from './plugin-test-handles'

// The unified /claude menu fetches missing or stale OAuth profiles before it
// shows the account and quota sections. These tests run the real plugin on a
// migrated native pool. Except where a test starts the startup profile display
// itself, they never call auth.loader: the menu must work before OpenCode
// first asks the plugin for credentials. Profile HTTP goes through a
// replaced global fetch, installed before the plugin captures it.

const { test, deferCleanup, trackDetached, gate } = createTestLifetimeSuite()

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const DAY = 24 * 60 * 60 * 1000
const mainIdentity = '11111111-1111-4111-8111-111111111111'
const fallbackIdentity = '22222222-2222-4222-8222-222222222222'
const otherIdentity = '33333333-3333-4333-8333-333333333333'
/** Which account each synthetic bearer belongs to. */
const bearerIdentity: Record<string, string> = {
  'sk-ant-oat01-synthetic-main-access': mainIdentity,
  'sk-ant-oat01-synthetic-main-rotated': mainIdentity,
  'sk-ant-oat01-synthetic-fallback-access': fallbackIdentity,
  'sk-ant-oat01-synthetic-fallback-rotated': fallbackIdentity,
  'sk-ant-oat01-synthetic-fallback-rotated-again': fallbackIdentity,
  'sk-ant-oat01-synthetic-other-access': otherIdentity,
  'sk-ant-oat01-synthetic-other-rotated': otherIdentity,
  'synthetic-vault-main-bearer': mainIdentity,
  'synthetic-vault-fallback-bearer': fallbackIdentity,
}
/** The access token a synthetic refresh credential is exchanged for. */
const rotatedAccess: Record<string, string> = {
  'synthetic-main-refresh': 'sk-ant-oat01-synthetic-main-rotated',
  'synthetic-fallback-refresh': 'sk-ant-oat01-synthetic-fallback-rotated',
  'synthetic-fallback-refresh-again':
    'sk-ant-oat01-synthetic-fallback-rotated-again',
  'synthetic-other-refresh': 'sk-ant-oat01-synthetic-other-rotated',
}
/** The tier the profile endpoint reports for each account. */
const accountTier: Record<string, string> = {
  [mainIdentity]: 'default_claude_max_20x',
  [fallbackIdentity]: 'default_claude_max_5x',
  [otherIdentity]: 'default_claude_max_10x',
}
const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
] as const

function profileResponse(tier: string, orgType = 'claude_max') {
  return Response.json({
    organization: { organization_type: orgType, rate_limit_tier: tier },
  })
}

/** Local credential checks resolve identity from the synthetic bearer, without HTTP. */
function nativeLocal(
  now?: () => number,
): NonNullable<NativeAccountRuntimeOptions['local']> {
  return {
    ...(now && { now }),
    resolveIdentity: async (accessToken) => {
      const identity = bearerIdentity[accessToken]
      if (!identity) throw new Error('Unknown synthetic bearer')
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: identity as ProviderAccountUuid,
      }
    },
    refreshToken: async (input) => {
      const rotated = rotatedAccess[input.refreshToken]
      if (!rotated) throw new Error('Unknown synthetic refresh credential')
      return {
        access: rotated,
        refresh: `${input.refreshToken}-next`,
        expires: Date.now() + DAY,
        expiresIn: DAY / 1000,
      }
    },
  }
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
        access: 'sk-ant-oat01-synthetic-fallback-access',
        refresh: 'synthetic-fallback-refresh',
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
      access: 'sk-ant-oat01-synthetic-main-access',
      refresh: 'synthetic-main-refresh',
      expires: Date.now() + 8 * 60 * 60_000,
    },
  }
}

/**
 * The profile endpoint and nothing else. Every profile request is recorded by
 * the account its bearer belongs to (rotation may have replaced the original
 * access token); `respond` may replace or delay the answer for an account.
 */
function createNetwork() {
  const network = {
    profileBearers: [] as string[],
    profileAccounts: [] as string[],
    unexpected: [] as string[],
    respond: undefined as
      | ((
          account: string,
          signal?: AbortSignal | null,
        ) => Promise<Response | undefined>)
      | undefined,
  }
  const saved = globalThis.fetch
  const fetchImpl = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== PROFILE_URL) {
        network.unexpected.push(url)
        return new Response('not found', { status: 404 })
      }
      const bearer = (
        new Headers(init?.headers).get('authorization') ?? ''
      ).replace(/^Bearer /, '')
      const account = bearerIdentity[bearer] ?? `unknown:${bearer}`
      network.profileBearers.push(bearer)
      network.profileAccounts.push(account)
      const replaced = await network.respond?.(account, init?.signal)
      if (replaced) return replaced
      const tier = accountTier[account]
      return tier
        ? profileResponse(tier)
        : new Response('unknown bearer', { status: 401 })
    },
    { preconnect: saved.preconnect },
  )
  return { network, fetchImpl }
}

interface Started {
  plugin: PluginHooks
  paths: NativePoolPaths
  root: string
  network: ReturnType<typeof createNetwork>['network']
  /** Opens /claude without a TUI and returns the text the plugin replied with. */
  readMenu(): Promise<string>
  /** Dispose the plugin, which also waits for its outstanding profile saves. */
  dispose(): Promise<void>
}

/**
 * Migrate a native pool, then start the plugin on it with the synthetic
 * network. Cleanups run in registration order, so the plugin is disposed and
 * the process state restored before the fixture removes its root.
 */
async function start(
  input: Pick<
    NativeOpencodeFixtureInput,
    'legacyConfig' | 'legacyState' | 'hostAuth' | 'custody'
  >,
  options: {
    claustrumScopedConnect?: () => Promise<NativeCustodyClient>
    beforePlugin?: (paths: NativePoolPaths) => Promise<void>
  } = {},
): Promise<Started> {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const plugins: PluginHooks[] = []
  deferCleanup(async () => {
    try {
      for (const plugin of plugins.splice(0)) await plugin.dispose?.()
    } finally {
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'oc-status-profile-'))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: { deferCleanup, trackDetached },
    ...input,
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()
  await options.beforePlugin?.(fixture.paths)
  const { network, fetchImpl } = createNetwork()
  globalThis.fetch = fetchImpl
  const replies: string[] = []
  const client = createOpencodeClient({
    baseUrl: 'http://127.0.0.1:9',
    // Stands in for the OpenCode server: records ignored replies and reports
    // an empty message history.
    fetch: async (request: Request) => {
      if (request.method === 'GET') return Response.json([])
      const body: unknown = await request.json().catch(() => undefined)
      const parts =
        body && typeof body === 'object' && 'parts' in body
          ? body.parts
          : undefined
      if (Array.isArray(parts))
        for (const part of parts)
          if (part && typeof part === 'object' && 'text' in part)
            replies.push(String(part.text))
      return new Response(null, { status: 204 })
    },
  })
  const creation = AnthropicAuthPlugin(
    {
      client,
      project: {
        id: 'native-status-profile',
        worktree: fixture.root,
        time: { created: Date.now() },
      },
      directory: fixture.root,
      worktree: fixture.root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    {
      scopedRosterPollIntervalMs: 0,
      cacheKeepAggregateRefreshIntervalMs: 0,
      // readMenu runs /claude without a TUI; reply at once instead of
      // waiting the real two seconds for a TUI to take the menu.
      tuiPickupTimeoutMs: 0,
      nativeLocal: nativeLocal(),
      ...(options.claustrumScopedConnect && {
        claustrumScopedConnect: options.claustrumScopedConnect,
      }),
    },
  )
  trackDetached(creation)
  const plugin = await creation
  plugins.push(plugin)
  return {
    plugin,
    paths: fixture.paths,
    root: fixture.root,
    network,
    async readMenu() {
      const before = replies.length
      const handled = plugin['command.execute.before']?.(
        { command: 'claude', arguments: '', sessionID: 'synthetic-session' },
        { parts: [] },
      )
      await expect(handled).rejects.toThrow()
      return replies.slice(before).join('\n')
    },
    async dispose() {
      const index = plugins.indexOf(plugin)
      if (index >= 0) plugins.splice(index, 1)
      await plugin.dispose?.()
    },
  }
}

// The first host-credential request starts OpenCode's background profile
// display; the loader returns without waiting for the profile fetch or save.
async function startStartupProfileDisplay(s: Started) {
  const loader = s.plugin.auth?.loader
  if (!loader) throw new Error('The plugin has no auth loader')
  await Promise.resolve(
    loader(
      async () =>
        custodyTombstoneOAuth('anthropic') as Awaited<
          ReturnType<Parameters<typeof loader>[0]>
        >,
      { models: {} } as unknown as Parameters<typeof loader>[1],
    ),
  )
}

async function waitForSidebarMainTier(tier: string) {
  let state = await getSidebarState()
  for (let attempt = 0; attempt < 300; attempt++) {
    if (state.main.tierLabel === tier) return state
    await drainSidebarWrites()
    await Bun.sleep(10)
    state = await getSidebarState()
  }
  throw new Error(
    `Sidebar main tier did not become ${tier}: ${JSON.stringify(state)}`,
  )
}

/** The /claude menu's own section headings, in order. */
const menuSections = [
  'Accounts',
  'Quota',
  'Routing',
  'Limits',
  'Cache',
  'Diagnostics',
  'Extras',
]

/** One menu section's text, up to the next menu section heading. */
function section(text: string, title: string) {
  const start = text.indexOf(`\n## ${title}\n`)
  if (start < 0) throw new Error(`Menu has no ${title} section:\n${text}`)
  const ends = menuSections
    .map((next) => text.indexOf(`\n## ${next}\n`, start + 1))
    .filter((index) => index > start)
  return text.slice(start, ends.length ? Math.min(...ends) : undefined)
}

/** The account-section line for one route. */
function accountLine(text: string, marker: string) {
  const line = section(text, 'Accounts')
    .split('\n')
    .find((candidate) => candidate.includes(marker))
  if (!line) throw new Error(`No account line for ${marker}:\n${text}`)
  return line
}

/** Saved profile tiers by route, read through a separate native runtime. */
async function storedTiers(
  paths: NativePoolPaths,
): Promise<Record<string, string | undefined>> {
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: nativeLocal(),
  })
  try {
    const snapshot = await runtime.read()
    return Object.fromEntries(
      snapshot.accounts
        .filter((account) => account.type === 'oauth')
        .map((account) => [account.id, account.profile?.tier]),
    )
  } finally {
    runtime.close()
  }
}

/** Save a profile for one route through the real runtime, as of `at`. */
async function seedProfile(
  paths: NativePoolPaths,
  routeId: string,
  tier: string,
  at: number,
) {
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: nativeLocal(() => at),
  })
  try {
    await runtime.fetchProfile(
      routeId,
      Object.assign(async () => profileResponse(tier), {
        preconnect: globalThis.fetch.preconnect,
      }),
    )
  } finally {
    runtime.close()
  }
}

/**
 * Take the runtime lock that every local metadata save needs and keep it
 * until `release` resolves. Resolves `held` once the lock is owned.
 */
function holdRuntimeLock(paths: NativePoolPaths, release: Promise<void>) {
  let acquired!: () => void
  const held = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const work = withLock(
    paths.runtime,
    { ...POOL_LOCK_DEFAULTS, name: 'native-runtime' },
    async () => {
      acquired()
      await release
    },
  )
  trackDetached(work)
  return { held, work }
}

test('menu shows fetched local profiles while their saves are still held', async () => {
  const s = await start({
    legacyConfig: localLegacyConfig(),
    hostAuth: localHostAuth(),
  })
  const release = gate()
  let hold: ReturnType<typeof holdRuntimeLock> | undefined
  // Set once the test's lock holder settles, which happens only after the
  // test releases the lock below. A false value after the menu returns means
  // the saves were still pending: no save needing the runtime lock could
  // have completed while the test still holds it.
  let savesSettled = false
  let bothArrived!: () => void
  const arrived = new Promise<void>((resolve) => {
    bothArrived = resolve
  })
  // Teardown opens the gate, so a request can never stay parked past the test.
  void release.wait.then(bothArrived)
  s.network.respond = async () => {
    // Answer only once both accounts' requests have arrived, and only while
    // holding the lock every local save needs: neither fetched profile can be
    // saved until the test releases it.
    if (s.network.profileAccounts.length === 2) {
      hold = holdRuntimeLock(s.paths, release.wait)
      await hold.held
      void hold.work.then(
        () => {
          savesSettled = true
        },
        () => {
          savesSettled = true
        },
      )
      bothArrived()
    }
    await arrived
    return undefined
  }
  const text = await s.readMenu()
  // The display renders fetched profiles without waiting for their saves: a
  // display that waited for saves could not have returned while the test
  // still holds the lock every save needs. The tier assertions below prove
  // the menu used the fetched profiles, and the runtime-file assertions after
  // them prove those profiles were still unsaved.
  expect(savesSettled).toBe(false)
  expect(accountLine(text, '[main]')).toContain('Max 20x')
  expect(accountLine(text, 'fallback-route')).toContain('Max 5x')
  expect(section(text, 'Quota')).toContain('Max 20x')
  expect(section(text, 'Quota')).toContain('Max 5x')
  // Each account was asked once with its own credential; the API route is not
  // an OAuth profile subject.
  expect(s.network.profileAccounts.sort()).toEqual(
    [mainIdentity, fallbackIdentity].sort(),
  )
  expect(s.network.profileBearers).not.toContain('synthetic-api-route-key')
  expect(s.network.unexpected).toEqual([])
  const runtimeText = await readFile(s.paths.runtime, 'utf8')
  expect(runtimeText).not.toContain(accountTier[mainIdentity])
  expect(runtimeText).not.toContain(accountTier[fallbackIdentity])
  release.open()
  await hold?.work
  await s.dispose()
  expect(await storedTiers(s.paths)).toEqual({
    main: accountTier[mainIdentity],
    'fallback-route': accountTier[fallbackIdentity],
  })
})

test('a failed profile request renders saved data silently and is not repeated this boot', async () => {
  const s = await start({
    legacyConfig: localLegacyConfig(),
    hostAuth: localHostAuth(),
  })
  s.network.respond = async (account) =>
    account === fallbackIdentity
      ? new Response('synthetic outage', { status: 503 })
      : undefined
  const first = await s.readMenu()
  expect(accountLine(first, '[main]')).toContain('Max 20x')
  expect(accountLine(first, 'fallback-route')).not.toContain('Max')
  expect(first).not.toContain('503')
  expect(first).not.toContain('profile check failed')
  expect(first).not.toContain('synthetic outage')
  const second = await s.readMenu()
  expect(accountLine(second, 'fallback-route')).not.toContain('Max')
  expect(s.network.profileAccounts.sort()).toEqual(
    [mainIdentity, fallbackIdentity].sort(),
  )
  await s.dispose()
  expect(await storedTiers(s.paths)).toEqual({
    main: accountTier[mainIdentity],
    'fallback-route': undefined,
  })
})

test('a stale saved profile is refreshed once and a fresh one is reused per boot', async () => {
  const s = await start(
    { legacyConfig: localLegacyConfig(), hostAuth: localHostAuth() },
    {
      beforePlugin: async (paths) => {
        // Older than the seven-day profile lifetime.
        await seedProfile(
          paths,
          'fallback-route',
          'default_claude_max_10x',
          Date.now() - 8 * DAY,
        )
        await seedProfile(
          paths,
          'main',
          accountTier[mainIdentity] ?? '',
          Date.now(),
        )
      },
    },
  )
  const first = await s.readMenu()
  expect(accountLine(first, '[main]')).toContain('Max 20x')
  expect(accountLine(first, 'fallback-route')).toContain('Max 5x')
  expect(s.network.profileAccounts).toEqual([fallbackIdentity])
  const second = await s.readMenu()
  expect(accountLine(second, 'fallback-route')).toContain('Max 5x')
  expect(s.network.profileAccounts).toEqual([fallbackIdentity])
  await s.dispose()
  expect(await storedTiers(s.paths)).toEqual({
    main: accountTier[mainIdentity],
    'fallback-route': accountTier[fallbackIdentity],
  })
})

test('a fresh saved profile survives access rotation without a new profile request', async () => {
  const s = await start(
    { legacyConfig: localLegacyConfig(), hostAuth: localHostAuth() },
    {
      beforePlugin: async (paths) => {
        await seedProfile(
          paths,
          'main',
          accountTier[mainIdentity] ?? '',
          Date.now(),
        )
        await seedProfile(
          paths,
          'fallback-route',
          accountTier[fallbackIdentity] ?? '',
          Date.now(),
        )
        // A later authorization finds the fallback access expired and
        // rotates it for the same account.
        const later = Date.now() + 9 * 60 * 60_000
        const runtime = createNativeAccountRuntime({
          paths,
          host: 'opencode',
          local: nativeLocal(() => later),
        })
        try {
          const rotated = await runtime.authorizeLocal('fallback-route')
          expect(rotated.status).toBe('usable')
        } finally {
          runtime.close()
        }
        expect(await readFile(paths.state, 'utf8')).toContain(
          'sk-ant-oat01-synthetic-fallback-rotated',
        )
      },
    },
  )
  const text = await s.readMenu()
  expect(accountLine(text, 'fallback-route')).toContain('Max 5x')
  expect(accountLine(text, '[main]')).toContain('Max 20x')
  expect(s.network.profileBearers).toEqual([])
})

test('a profile read for a replaced account is not shown or saved for its successor', async () => {
  const s = await start({
    legacyConfig: localLegacyConfig(),
    hostAuth: localHostAuth(),
  })
  const release = gate()
  const replacementIdentified = gate()
  let hold: ReturnType<typeof holdRuntimeLock> | undefined
  let bothArrived!: () => void
  const arrived = new Promise<void>((resolve) => {
    bothArrived = resolve
  })
  void release.wait.then(bothArrived)
  s.network.respond = async (account) => {
    if (account === fallbackIdentity) {
      // The route signs in to a different account while its profile request
      // is in flight, and that account is identified before the display
      // reads the route again.
      const runtime = createNativeAccountRuntime({
        paths: s.paths,
        host: 'opencode',
        local: nativeLocal(),
      })
      try {
        await runtime.loginOAuth({
          routeId: 'fallback-route',
          credential: {
            access: 'sk-ant-oat01-synthetic-other-access',
            refresh: 'synthetic-other-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
          replace: true,
        })
        expect((await runtime.authorizeLocal('fallback-route')).status).toBe(
          'usable',
        )
        replacementIdentified.open()
      } finally {
        runtime.close()
      }
    }
    // Taking the runtime lock before the new login commits would block that
    // login until after the menu's last display, leaving no successor to fetch.
    await replacementIdentified.wait
    // Hold the lock every local profile save needs while the menu renders.
    // The previous account's profile save for this route is refused at once
    // anyway, because it no longer matches the route's credential, so the
    // test checks the outcome (that profile never appears on the replacement
    // account) rather than which of the display's guards stopped it.
    if (s.network.profileAccounts.length >= 2 && !hold) {
      hold = holdRuntimeLock(s.paths, release.wait)
      await hold.held
      bothArrived()
    }
    await arrived
    return undefined
  }
  const text = await s.readMenu()
  expect(accountLine(text, 'fallback-route')).not.toContain('Max')
  expect(accountLine(text, '[main]')).toContain('Max 20x')
  release.open()
  await hold?.work
  await s.dispose()
  // Only the new account's own profile, fetched by a later display, is saved
  // for the route; the old account's profile was refused.
  expect((await storedTiers(s.paths))['fallback-route']).toBe(
    accountTier[otherIdentity],
  )
})
test('an expired unidentified profile attempt cannot replace its successor account request', async () => {
  const s = await start(
    { legacyConfig: localLegacyConfig(), hostAuth: localHostAuth() },
    {
      beforePlugin: async (paths) => {
        await seedProfile(
          paths,
          'main',
          accountTier[mainIdentity] ?? '',
          Date.now(),
        )
      },
    },
  )
  const release = gate()
  const expired = gate()
  let firstSignal: AbortSignal | undefined
  s.network.respond = async (account, signal) => {
    if (account !== fallbackIdentity || firstSignal) return undefined
    if (!signal) throw new Error('Profile request has no deadline signal')
    firstSignal = signal
    signal.addEventListener('abort', () => expired.open(), { once: true })
    // Ignore cancellation until teardown so the expired attempt remains
    // pending when a later display has to choose the successor's request.
    await release.wait
    return undefined
  }
  const firstMenu = s.readMenu()
  trackDetached(firstMenu)
  await expired.wait
  await firstMenu
  expect(firstSignal?.aborted).toBe(true)

  const runtime = createNativeAccountRuntime({
    paths: s.paths,
    host: 'opencode',
    local: nativeLocal(),
  })
  try {
    await runtime.loginOAuth({
      routeId: 'fallback-route',
      credential: {
        access: 'sk-ant-oat01-synthetic-other-access',
        refresh: 'synthetic-other-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
      replace: true,
    })
    expect((await runtime.authorizeLocal('fallback-route')).status).toBe(
      'usable',
    )
  } finally {
    runtime.close()
  }

  const text = await s.readMenu()
  expect(accountLine(text, 'fallback-route')).toContain('Max 10x')
  expect(accountLine(text, 'fallback-route')).not.toContain('Max 5x')
  expect(
    s.network.profileAccounts.filter((id) => id === otherIdentity),
  ).toHaveLength(1)
  // The profile helper rejects on the display deadline even when the transport
  // ignores cancellation. The menu's quota section does not retry that failed
  // profile request during this boot; a new login still fetches its own profile.
  expect(
    s.network.profileAccounts.filter((id) => id === fallbackIdentity),
  ).toHaveLength(1)
  release.open()
  await s.dispose()
  expect((await storedTiers(s.paths))['fallback-route']).toBe(
    accountTier[otherIdentity],
  )
})

test('vault accounts show fetched profiles through vault-issued credentials', async () => {
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
  const material: Record<string, string> = {
    'oauth:anthropic': 'synthetic-vault-main-bearer',
    'oauth:secondary': 'synthetic-vault-fallback-bearer',
  }
  const client: NativeCustodyClient = {
    async listScoped() {
      return {
        view: 'synthetic-native-view',
        rows: [
          row('oauth:anthropic', mainIdentity),
          row('oauth:secondary', fallbackIdentity),
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped(input) {
      return {
        credentialId: input.credentialId,
        accountId:
          input.credentialId === 'oauth:anthropic'
            ? mainIdentity
            : fallbackIdentity,
        material: material[input.credentialId] ?? '',
        recordVersion: 1,
        expiresAtMs: Date.now() + 60 * 60_000,
      }
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
  const s = await start(
    {
      legacyConfig: {
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
      },
      hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
      custody: {
        connect: async () => client,
        enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
      },
    },
    { claustrumScopedConnect: async () => client },
  )
  const text = await s.readMenu()
  expect(accountLine(text, '[main]')).toContain('Max 20x')
  expect(accountLine(text, '[fallback]')).toContain('Max 5x')
  expect(s.network.profileBearers.sort()).toEqual([
    'synthetic-vault-fallback-bearer',
    'synthetic-vault-main-bearer',
  ])
  await s.dispose()
  expect(Object.values(await storedTiers(s.paths)).sort()).toEqual(
    [accountTier[mainIdentity], accountTier[fallbackIdentity]].sort(),
  )
})

test('a menu opened while startup fetches an unidentified route joins that request', async () => {
  const s = await start(
    { legacyConfig: localLegacyConfig(), hostAuth: localHostAuth() },
    {
      beforePlugin: async (paths) => {
        // Main already has a fresh saved profile, so only the fallback route
        // needs a profile request.
        await seedProfile(
          paths,
          'main',
          accountTier[mainIdentity] ?? '',
          Date.now(),
        )
      },
    },
  )
  expect(await storedTiers(s.paths)).toEqual({
    main: accountTier[mainIdentity],
    'fallback-route': undefined,
  })
  const release = gate()
  let fallbackArrived!: () => void
  const arrived = new Promise<void>((resolve) => {
    fallbackArrived = resolve
  })
  s.network.respond = async (account) => {
    // The menu sends the request for the account added before it opened
    // only after it has decided, for every route, whether to join an
    // existing profile request or send a new one. Releasing the held
    // fallback answer at that point cannot hide a second fallback request,
    // and the menu waits for every request it sent before it renders.
    if (account === otherIdentity) release.open()
    if (
      account === fallbackIdentity &&
      s.network.profileAccounts.filter((entry) => entry === fallbackIdentity)
        .length === 1
    ) {
      fallbackArrived()
      await release.wait
    }
    return undefined
  }
  // OpenCode's first credential request starts the startup profile display,
  // which has no time bound of its own.
  const loader = s.plugin.auth?.loader
  if (!loader) throw new Error('The plugin has no auth loader')
  await loader(
    async () =>
      custodyTombstoneOAuth('anthropic') as Awaited<
        ReturnType<Parameters<typeof loader>[0]>
      >,
    { models: {} } as unknown as Parameters<typeof loader>[1],
  )
  // The startup request has authorized the fallback route, which recorded
  // the route's account identity, and its answer is still held.
  await arrived
  const runtime = createNativeAccountRuntime({
    paths: s.paths,
    host: 'opencode',
    local: nativeLocal(),
  })
  try {
    await runtime.loginOAuth({
      routeId: 'other-route',
      credential: {
        access: 'sk-ant-oat01-synthetic-other-access',
        refresh: 'synthetic-other-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
      replace: false,
    })
  } finally {
    runtime.close()
  }
  const text = await s.readMenu()
  expect(accountLine(text, 'fallback-route')).toContain('Max 5x')
  expect(accountLine(text, 'other-route')).toContain('Max 10x')
  // One request per account: the menu joined the startup fallback request
  // that was still in flight instead of repeating it.
  expect(s.network.profileAccounts.sort()).toEqual(
    [fallbackIdentity, otherIdentity].sort(),
  )
  expect(s.network.unexpected).toEqual([])
})

test('missing native authority refuses status without any profile request', async () => {
  const s = await start({
    legacyConfig: localLegacyConfig(),
    hostAuth: localHostAuth(),
  })
  await rm(s.paths.journal, { force: true })
  const text = await s.readMenu()
  expect(section(text, 'Accounts')).not.toContain('Max')
  expect(s.network.profileBearers).toEqual([])
})

test('sidebar keeps a failed-save tier through refresh and drops it after replacement', async () => {
  const savedLevel = getLogLevel()
  const s = await start({
    legacyConfig: { ...localLegacyConfig(), accounts: [] },
    hostAuth: localHostAuth(),
  })
  const records: Array<{
    level: string
    channel: string
    message: string
    payload?: unknown
  }> = []
  const runtimeDirectory = dirname(s.paths.runtime)
  const originalDirectoryMode = (await stat(runtimeDirectory)).mode & 0o777
  let warningLogged!: () => void
  const warning = new Promise<void>((resolve) => {
    warningLogged = resolve
  })
  __setLogTestSink((record) => {
    records.push(record)
    if (
      record.level === 'warn' &&
      record.channel === 'quota' &&
      record.message === 'failed to persist account profile'
    )
      warningLogged()
  })
  try {
    setLogLevel('debug')
    s.network.respond = async () => {
      // The runtime metadata file is atomically renamed in this directory.
      // Removing write permission makes that save fail while leaving reads open.
      await chmod(runtimeDirectory, originalDirectoryMode & ~0o222)
      return undefined
    }
    await startStartupProfileDisplay(s)
    await warning
    await chmod(runtimeDirectory, originalDirectoryMode)

    const state = await waitForSidebarMainTier('Max 20x')
    expect(state.main.tierLabel).toBe('Max 20x')

    const refreshSidebarQuota = getPluginTestHandles(
      s.plugin,
    ).refreshSidebarQuota
    await refreshSidebarQuota()
    await drainSidebarWrites()
    expect((await getSidebarState()).main.tierLabel).toBe('Max 20x')

    const runtime = createNativeAccountRuntime({
      paths: s.paths,
      host: 'opencode',
      local: nativeLocal(),
    })
    try {
      await runtime.loginOAuth({
        routeId: 'main',
        credential: {
          access: 'sk-ant-oat01-synthetic-other-access',
          refresh: 'synthetic-other-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        replace: true,
      })
      expect((await runtime.authorizeLocal('main')).status).toBe('usable')
    } finally {
      runtime.close()
    }
    await refreshSidebarQuota()
    await drainSidebarWrites()
    expect((await getSidebarState()).main.tierLabel).toBeUndefined()

    const warnings = records.filter(
      (record) =>
        record.level === 'warn' &&
        record.channel === 'quota' &&
        record.message === 'failed to persist account profile',
    )
    expect(warnings).toHaveLength(1)
    expect(JSON.stringify(warnings)).not.toContain(
      accountTier[mainIdentity] ?? '',
    )
    expect(JSON.stringify(warnings)).not.toContain(mainIdentity)

    await s.dispose()
    await drainSidebarWrites()
  } finally {
    await chmod(runtimeDirectory, originalDirectoryMode)
    __setLogTestSink(null)
    setLogLevel(savedLevel)
  }
})

test('sidebar does not show a profile whose save was refused', async () => {
  const savedLevel = getLogLevel()
  const refused = gate()
  const s = await start({
    legacyConfig: { ...localLegacyConfig(), accounts: [] },
    hostAuth: localHostAuth(),
  })
  __setLogTestSink((record) => {
    if (
      record.message === 'refused account profile publication' &&
      record.payload?.account === 'main'
    )
      refused.open()
  })
  try {
    setLogLevel('debug')
    s.network.respond = async () => {
      const runtime = createNativeAccountRuntime({
        paths: s.paths,
        host: 'opencode',
        local: nativeLocal(),
      })
      try {
        await runtime.loginOAuth({
          routeId: 'main',
          credential: {
            access: 'sk-ant-oat01-synthetic-main-rotated',
            refresh: 'synthetic-main-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
          replace: true,
        })
        expect((await runtime.authorizeLocal('main')).status).toBe('usable')
      } finally {
        runtime.close()
      }
      return undefined
    }
    await startStartupProfileDisplay(s)
    await refused.wait
    await s.dispose()
    await drainSidebarWrites()

    expect((await getSidebarState()).main.tierLabel).toBeUndefined()
  } finally {
    __setLogTestSink(null)
    setLogLevel(savedLevel)
  }
})

test('sidebar does not show a fetched profile after account replacement', async () => {
  const savedLevel = getLogLevel()
  const refused = gate()
  const s = await start({
    legacyConfig: { ...localLegacyConfig(), accounts: [] },
    hostAuth: localHostAuth(),
  })
  __setLogTestSink((record) => {
    if (
      record.message === 'refused account profile publication' &&
      record.payload?.account === 'main'
    )
      refused.open()
  })
  try {
    setLogLevel('debug')
    s.network.respond = async () => {
      const runtime = createNativeAccountRuntime({
        paths: s.paths,
        host: 'opencode',
        local: nativeLocal(),
      })
      try {
        await runtime.loginOAuth({
          routeId: 'main',
          credential: {
            access: 'sk-ant-oat01-synthetic-other-access',
            refresh: 'synthetic-other-refresh',
            expires: Date.now() + 8 * 60 * 60_000,
          },
          replace: true,
        })
        expect((await runtime.authorizeLocal('main')).status).toBe('usable')
      } finally {
        runtime.close()
      }
      return undefined
    }
    await startStartupProfileDisplay(s)
    await refused.wait
    await s.dispose()
    await drainSidebarWrites()

    expect((await getSidebarState()).main.tierLabel).toBeUndefined()
    expect(s.network.profileAccounts).toEqual([mainIdentity])
  } finally {
    __setLogTestSink(null)
    setLogLevel(savedLevel)
  }
})

test('a profile whose save was refused is not shown once the refusal is known', async () => {
  const savedLevel = getLogLevel()
  let saveRefused!: () => void
  const refused = new Promise<void>((resolve) => {
    saveRefused = resolve
  })
  // The deferred refusal gate: `refused` resolves when the plugin logs that
  // it refused to publish the fallback profile. Teardown opens `teardown` before it
  // joins the test body, so a body still waiting for a refusal that never
  // came is released instead of hanging teardown.
  const teardown = gate()
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(savedLevel)
  })
  __setLogTestSink((record) => {
    if (
      record.message === 'refused account profile publication' &&
      record.payload?.account === 'fallback-route'
    )
      saveRefused()
  })
  const s = await start({
    legacyConfig: localLegacyConfig(),
    hostAuth: localHostAuth(),
  })
  // The plugin applies its stored log level during startup; set this test's
  // diagnostic level afterwards.
  setLogLevel('debug')
  s.network.respond = async (account) => {
    if (account !== fallbackIdentity) return undefined
    // The same account signs in again while its profile request is in
    // flight. The new credential keeps the account identity but replaces the
    // credential the profile was read with, so the save is refused.
    const runtime = createNativeAccountRuntime({
      paths: s.paths,
      host: 'opencode',
      local: nativeLocal(),
    })
    try {
      await runtime.loginOAuth({
        routeId: 'fallback-route',
        credential: {
          access: 'sk-ant-oat01-synthetic-fallback-rotated',
          refresh: 'synthetic-fallback-refresh-again',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        replace: true,
      })
      // Authorizing the new credential records its (unchanged) account
      // identity, so the route the display reads still names the account
      // the profile was read for: only the refused save can hide it.
      expect((await runtime.authorizeLocal('fallback-route')).status).toBe(
        'usable',
      )
    } finally {
      runtime.close()
    }
    return undefined
  }
  await s.readMenu()
  await Promise.race([refused, teardown.wait])
  const text = await s.readMenu()
  expect(accountLine(text, 'fallback-route')).not.toContain('Max')
  expect(accountLine(text, '[main]')).toContain('Max 20x')
  // The refused profile is not requested again in this boot.
  expect(s.network.profileAccounts.sort()).toEqual(
    [mainIdentity, fallbackIdentity].sort(),
  )
  await s.dispose()
  expect((await storedTiers(s.paths))['fallback-route']).toBeUndefined()
})

test('a profile request that throws secret-bearing text leaks it to no log, reply or status', async () => {
  // Not shaped like a bearer, API key or JWT, so the logger's own value
  // redaction cannot hide a leak: only the code under test can keep it out.
  const marker = 'synthetic-leak-marker-5f1c'
  const savedLevel = getLogLevel()
  const records: unknown[] = []
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(savedLevel)
  })
  __setLogTestSink((record) => {
    records.push(record)
  })
  const s = await start({
    legacyConfig: localLegacyConfig(),
    hostAuth: localHostAuth(),
  })
  // The plugin applies its stored log level during startup; set this test's
  // diagnostic level afterwards so debug records are captured.
  setLogLevel('debug')
  s.network.respond = async (account) => {
    if (account === fallbackIdentity)
      throw new Error(`profile transport failed near ${marker}`)
    return undefined
  }
  const text = await s.readMenu()
  expect(accountLine(text, '[main]')).toContain('Max 20x')
  expect(accountLine(text, 'fallback-route')).not.toContain('Max')
  expect(s.network.profileAccounts).toContain(fallbackIdentity)
  expect(text).not.toContain(marker)
  expect(JSON.stringify(records)).not.toContain(marker)
  expect(JSON.stringify(records)).toContain('failed to hydrate account profile')
})
