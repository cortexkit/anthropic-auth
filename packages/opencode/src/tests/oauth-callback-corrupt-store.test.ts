import { describe, expect } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  getLogLevel,
  type LogTestRecord,
  type NativePoolPaths,
  type ProviderAccountUuid,
  resetClaudeCodeIdentityCachesForTest,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { getPluginTestHandles } from './plugin-test-handles'
import { extractUrl, TOKEN_URL } from './test-fetch'
import { createTimerTracking } from './timer-tracking'

// The Claude Pro/Max sign-in saves the exchanged login into the migrated
// native account pool and hands OpenCode only an inert activation marker.
// These tests corrupt a file between authorize() (which requires a committed
// local migration) and the pasted-code callback, and check which corruptions
// the callback may tolerate:
// - the retired legacy settings file is an optional import source after the
//   migration, so a malformed copy must not discard the exchanged login;
// - the native pool is the authority for credentials, so a malformed pool
//   must refuse the save rather than guess, and still never return the
//   exchanged secrets to OpenCode's auth slot.
// Neither case may log the malformed bytes, which carry a secret-shaped canary.

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test
const timerTracking = createTimerTracking()

// Every path variable that migrateNativeOpencodeFixture returns in its env,
// plus the profile-hydration switch and OPENCODE_AUTH_CONTENT, which this file
// sets or clears. Saved before each body and restored by its cleanup.
const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
] as const

const EXCHANGED_ACCESS = 'sk-ant-oat01-synthetic-exchanged-access'
const EXCHANGED_REFRESH = 'synthetic-exchanged-refresh'
const EXCHANGED_UUID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0'
const BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap'
// Truncated JSON (unparseable) that still carries a secret-shaped value, so a
// log line or error that echoes the raw bytes is detectable.
const MALFORMED_CANARY = 'sk-ant-oat01-synthetic-malformed-canary'
const MALFORMED_BYTES = `{"accounts":[{"type":"oauth","access":"${MALFORMED_CANARY}"`
const CALLBACK_INPUT = 'code=user-code&state=test-state'

/**
 * The context OpenCode passes a server plugin, with a real SDK client whose
 * HTTP transport is answered in this process, so nothing leaves the test.
 */
function hostContext(directory: string): PluginInput {
  const client = createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    fetch: async () => Response.json({ name: 'NotFound' }, { status: 404 }),
  })
  return {
    client,
    project: {
      id: 'oauth-callback-corrupt-store',
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL('http://opencode.invalid'),
    experimental_workspace: { register() {} },
    $,
  }
}

/** Plugin construction starts a fallback-account refresh and exposes its promise for tests. */
function fallbackRefreshReady(hooks: Hooks): Promise<unknown> {
  const ready = getPluginTestHandles(hooks).fallbackRefreshReady
  if (!(ready instanceof Promise))
    throw new Error('Plugin did not expose its startup fallback refresh')
  return ready
}

function proMaxMethod(plugin: Hooks) {
  const method = plugin.auth?.methods.find(
    (candidate) => candidate.label === 'Claude Pro/Max',
  )
  if (method?.type !== 'oauth')
    throw new Error('Plugin offers no Claude Pro/Max sign-in')
  return method
}

/**
 * Migrate an empty legacy installation through the real offline migration,
 * point this process at the result, answer the token exchange and the
 * identity bootstrap for the synthetic login, and start one plugin.
 *
 * Lifetime cleanups run in registration order, and the fixture registers the
 * removal of its root when it is called. Registering the teardown below first
 * means the plugin is disposed and the process-wide fetch, env, and log hooks
 * are restored before any fixture file is deleted.
 */
async function migratedSignIn() {
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const savedFetch = globalThis.fetch
  const savedLogLevel = getLogLevel()
  const plugins = new Set<Hooks>()
  lifetimes.deferCleanup(async () => {
    const results = await Promise.allSettled(
      [...plugins].map((plugin) =>
        Promise.resolve().then(() => plugin.dispose?.()),
      ),
    )
    plugins.clear()
    try {
      await drainSidebarWrites()
    } finally {
      timerTracking.reset()
      __setLogTestSink(null)
      setLogLevel(savedLogLevel)
      resetClaudeCodeIdentityCachesForTest()
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Plugin disposal failed',
      )
  })

  const requests: string[] = []
  // The real exchange() and the real identity lookup both read the global
  // fetch. Only the exact synthetic login token is recognised by bootstrap;
  // any other request is a test failure, never a network call.
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = extractUrl(input)
      requests.push(url.split('?')[0] ?? url)
      if (url === TOKEN_URL)
        return Response.json({
          access_token: EXCHANGED_ACCESS,
          refresh_token: EXCHANGED_REFRESH,
          expires_in: 8 * 3600,
        })
      if (url.startsWith(`${BOOTSTRAP_URL}?`)) {
        const authorization = new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get('authorization')
        if (authorization !== `Bearer ${EXCHANGED_ACCESS}`)
          return new Response('unauthorized', { status: 401 })
        return Response.json({
          oauth_account: { account_uuid: EXCHANGED_UUID },
        })
      }
      throw new Error(`Unexpected test fetch: ${url}`)
    },
    { preconnect: savedFetch.preconnect },
  )
  resetClaudeCodeIdentityCachesForTest()
  timerTracking.reset()

  const root = await mkdtemp(join(tmpdir(), 'oauth-callback-corrupt-'))
  // migrateNativeOpencodeFixture schedules removal of the directory only after
  // it accepts it. Remove it here too, so a refused directory is not left behind.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
    },
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  // Startup otherwise fetches each OAuth account's profile in the background;
  // that request is unrelated to the sign-in under test.
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  delete process.env.OPENCODE_AUTH_CONTENT

  const creation = AnthropicAuthPlugin(hostContext(fixture.root), {
    ...timerTracking.disabledPluginTimerOverrides(),
    authorize: async () => ({
      url: 'https://example.com/oauth/authorize',
      verifier: 'test-verifier',
      redirectUri: 'https://example.com/callback',
      state: 'test-state',
    }),
  })
  lifetimes.trackDetached(creation)
  const plugin = await creation
  plugins.add(plugin)
  lifetimes.trackDetached(fallbackRefreshReady(plugin))

  const records: LogTestRecord[] = []
  // Capture every level, so a debug line echoing the malformed bytes is seen too.
  setLogLevel('trace')
  __setLogTestSink((record) => {
    records.push(record)
  })
  return { fixture, plugin, requests, records }
}

/** Read the pool back through a fresh runtime that must not refresh or re-identify another token. */
async function storedMainLogin(paths: NativePoolPaths) {
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      refreshToken: async () => {
        throw new Error('Unexpected token refresh after fresh sign-in')
      },
      resolveIdentity: async (access) => {
        expect(access).toBe(EXCHANGED_ACCESS)
        return {
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
          accountUuid: EXCHANGED_UUID as ProviderAccountUuid,
        }
      },
    },
  })
  try {
    const snapshot = await runtime.read()
    const main = snapshot.accounts.find((account) => account.id === 'main')
    const authorized = await runtime.authorizeLocal('main')
    return { main, authorized }
  } finally {
    runtime.close()
  }
}

function expectNoSecretIn(text: string) {
  expect(text).not.toContain(MALFORMED_CANARY)
  expect(text).not.toContain(EXCHANGED_ACCESS)
  expect(text).not.toContain(EXCHANGED_REFRESH)
}

describe('OAuth exchange callback — corrupt account files between authorize() and callback()', () => {
  test('a malformed retired legacy settings file does not discard the exchanged native login', async () => {
    const { fixture, plugin, requests, records } = await migratedSignIn()
    const flow = await proMaxMethod(plugin).authorize()
    if (flow.method !== 'code')
      throw new Error('Expected code-based OAuth sign-in')

    // Corrupt the retired legacy settings AFTER authorize() returned its flow
    // and BEFORE the user pastes the code: the re-login recovery scenario of a
    // partially written or damaged file at the moment the callback runs.
    await writeFile(fixture.paths.legacyConfig, MALFORMED_BYTES, 'utf8')

    const result = await flow.callback(CALLBACK_INPUT)

    // OpenCode stores only the inert activation marker; the exchanged
    // credentials live in the native pool.
    const activation = custodyTombstoneOAuth('anthropic')
    expect(result).toEqual({
      type: 'success',
      access: activation.access,
      refresh: activation.refresh,
      expires: activation.expires,
    })
    expectNoSecretIn(JSON.stringify(result))

    // The exchange ran once and the identity was verified for exactly the
    // exchanged token before it was saved.
    expect(requests).toEqual([TOKEN_URL, BOOTSTRAP_URL])

    const { main, authorized } = await storedMainLogin(fixture.paths)
    expect(main?.type).toBe('oauth')
    expect(main?.accountIdentity).toBe(EXCHANGED_UUID)
    expect(authorized).toMatchObject({ status: 'usable' })
    if (authorized.status !== 'usable')
      throw new Error('Exchanged login did not authorize from the native pool')
    expect(authorized.access).toBe(EXCHANGED_ACCESS)
    expect(authorized.subject.binding.identity).toBe(EXCHANGED_UUID)

    // The retired file is never rewritten, and nothing logged its bytes.
    expect(await readFile(fixture.paths.legacyConfig, 'utf8')).toBe(
      MALFORMED_BYTES,
    )
    expectNoSecretIn(JSON.stringify(records))
  })

  test('a malformed native pool refuses the save and returns no credentials to OpenCode', async () => {
    const { fixture, plugin, requests, records } = await migratedSignIn()
    const flow = await proMaxMethod(plugin).authorize()
    if (flow.method !== 'code')
      throw new Error('Expected code-based OAuth sign-in')

    // The pool config is the credential authority once the migration has
    // committed; a damaged copy must not be replaced by a guess.
    await writeFile(fixture.paths.config, MALFORMED_BYTES, 'utf8')

    const outcome = await flow.callback(CALLBACK_INPUT).then(
      (result) => ({ settled: 'resolved' as const, value: result }),
      (error: unknown) => ({ settled: 'rejected' as const, value: error }),
    )
    // The callback must not report success: OpenCode would otherwise record
    // a sign-in that the pool never stored.
    expect(outcome.settled).toBe('rejected')
    // The refusal comes from reading the damaged pool, before the exchanged
    // token is sent anywhere for the identity lookup.
    expect(outcome.value).toMatchObject({
      name: 'NativeRuntimeError',
      code: 'publication-refused',
    })
    expect(requests).toEqual([TOKEN_URL])
    if (!(outcome.value instanceof Error))
      throw new Error('Callback rejected with a non-Error value')
    expectNoSecretIn(outcome.value.message)
    expectNoSecretIn(String(outcome.value.stack))

    // The damaged authority is left for the user to repair, untouched.
    expect(await readFile(fixture.paths.config, 'utf8')).toBe(MALFORMED_BYTES)
    expectNoSecretIn(JSON.stringify(records))
  })
})
