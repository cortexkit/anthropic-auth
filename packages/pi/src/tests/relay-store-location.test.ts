// A relay is honoured only from the account store in its default place for
// the operating system account. These tests move Pi's store with one
// environment variable, as a repository's `.env` could, and check that the
// bearer Thalamus hands out is sent directly to Anthropic and never to the
// relay the moved store names.
import { expect } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import { TEST_RELAY_ACCOUNT_HOME_KEY } from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

const lifetimes = createTestLifetimeSuite()
const vaultKey = Symbol.for('cortexkit.vault')
const globals = globalThis as unknown as Record<symbol, unknown>
const model: Model<Api> = {
  id: 'claude-fable-5-1',
  name: 'Fable',
  provider: 'anthropic',
  api: 'cortexkit-anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}
const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
const accountId = '11111111-2222-4333-8444-555555555555'
const credentialId = 'oauth:anthropic'
const BEARER = 'USER-REAL-THALAMUS-BEARER'

/** Thalamus custody: it hands out the user's real bearer. */
function userHostedVault() {
  return {
    listScoped: async () => ({
      view: 'same-view',
      rows: [
        {
          id: credentialId,
          accountId,
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
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async () => ({
      credentialId,
      accountId,
      material: BEARER,
      recordVersion: 8,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
}

const keys = [
  'PI_CODING_AGENT_DIR',
  'PI_AGENT_DIR',
  'PI_ANTHROPIC_AUTH_FILE',
  'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'CORTEXKIT_VAULT_HOST',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
]

interface RunOptions {
  /** Thalamus custody (the default), or Pi's own vault enrollment. */
  readonly custody?: 'hosted' | 'vault'
  readonly fallbackToDirect?: boolean
  /** Sets a proxy setting that would carry plain-http requests. */
  readonly proxy?: boolean
}

/**
 * Pi with vault or Thalamus custody, a relay saved in a store at `storeDir`
 * and the OS account home stubbed to `home`; `point` sets the variables that
 * select the store. Returns what the relay and the mock Anthropic API
 * received.
 */
async function run(
  base: string,
  storeDir: string,
  home: string,
  point: () => void,
  options: RunOptions = {},
) {
  await mkdir(storeDir, { recursive: true, mode: 0o700 })
  const storagePath = join(storeDir, 'anthropic-auth.json')
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  const prior = globals[vaultKey]
  const originalFetch = globalThis.fetch
  const seen: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const text = await request.text()
      try {
        seen.push(
          (
            JSON.parse(text) as {
              upstream?: { headers?: Record<string, string> }
            }
          ).upstream?.headers?.authorization ?? '<none>',
        )
      } catch {
        seen.push('<unparsed>')
      }
      return new Response(SSE, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  lifetimes.deferCleanup(async () => {
    await closePiNativeRuntime(storagePath)
    server.stop(true)
    globalThis.fetch = originalFetch
    if (prior === undefined) delete globals[vaultKey]
    else globals[vaultKey] = prior
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    core.resetVaultHostAuthorityForTests?.()
    await rm(base, { recursive: true, force: true })
  })
  const relayUrl = `http://127.0.0.1:${server.port}/forward`
  // Pi keeps its state file beside the account file.
  delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  await saveNativePiFixture({ version: 1, accounts: [] }, storagePath, {
    primary: false,
  })
  core.resetVaultHostAuthorityForTests?.()
  if (options.custody === 'vault') {
    const tokenPath = join(base, 'pi-enrollment.json')
    await writeFile(
      tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  } else {
    process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
    globals[vaultKey] = () => userHostedVault()
  }
  {
    // Saved while the preload skips the location check, as a store
    // prepared by someone else would be.
    const runtime = core.createNativeAccountRuntime({
      paths: await core.resolveNativePoolPaths(
        storagePath,
        join(storeDir, 'anthropic-auth-state.json'),
        core.LEGACY_STATE_LAYOUT,
      ),
      host: 'pi',
    })
    try {
      await runtime.updateRelay({
        enabled: true,
        url: relayUrl,
        token: 'relay-token',
        transport: 'http',
        fallbackToDirect: options.fallbackToDirect ?? false,
      })
    } finally {
      await runtime.close()
    }
  }
  globals[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  for (const key of [
    'PI_CODING_AGENT_DIR',
    'PI_AGENT_DIR',
    'PI_ANTHROPIC_AUTH_FILE',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ])
    delete process.env[key]
  point()
  // Nothing listens there; the proxy must never be reached.
  if (options.proxy) process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  // Pi's own vault custody connects through the runtime this stream uses.
  if (options.custody === 'vault')
    getPiNativeRuntime(storagePath, {
      connect: async () => userHostedVault() as never,
      vaultPoll: { intervalMs: 0 },
    })
  const direct: string[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.startsWith(relayUrl)) return originalFetch(input, init)
      if (!url.includes('/v1/messages')) return Response.json({})
      direct.push(
        new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get('authorization') ?? '<none>',
      )
      return new Response(SSE, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
    { preconnect: originalFetch.preconnect },
  )
  const result = await streamCortexKitAnthropic(model, context, {
    sessionId: 'relay-store-location',
  }).result()
  return { result, seen, direct, storagePath }
}

for (const variable of [
  'PI_ANTHROPIC_AUTH_FILE',
  'PI_CODING_AGENT_DIR',
] as const)
  lifetimes.test(
    `Pi hosted: a relay in a store moved by ${variable} is ignored`,
    () =>
      trackPiTestBody(
        (async () => {
          const base = await mkdtemp(join(tmpdir(), 'pi-relay-location-'))
          const home = join(base, 'home')
          const otherDir = join(base, 'other-agent')
          const { result, seen, direct } = await run(
            base,
            otherDir,
            home,
            () => {
              if (variable === 'PI_ANTHROPIC_AUTH_FILE')
                process.env.PI_ANTHROPIC_AUTH_FILE = join(
                  otherDir,
                  'anthropic-auth.json',
                )
              else process.env.PI_CODING_AGENT_DIR = otherDir
            },
          )
          expect(result.stopReason).toBe('stop')
          expect(seen).toEqual([])
          expect(direct).toEqual([`Bearer ${BEARER}`])
        })(),
      ),
    25_000,
  )

for (const custody of ['hosted', 'vault'] as const)
  lifetimes.test(
    `Pi ${custody}: a relay in the default store is still used`,
    () =>
      trackPiTestBody(
        (async () => {
          const base = await mkdtemp(join(tmpdir(), 'pi-relay-location-'))
          const home = join(base, 'home')
          const agentDir = join(home, '.pi', 'agent')
          const { result, seen, direct } = await run(
            base,
            agentDir,
            home,
            () => {
              process.env.PI_CODING_AGENT_DIR = agentDir
            },
            { custody },
          )
          expect(result.stopReason).toBe('stop')
          expect(seen).toEqual([`Bearer ${BEARER}`])
          expect(direct).toEqual([])
        })(),
      ),
    25_000,
  )

lifetimes.test(
  'Pi hosted: a plain-http relay in the default store that a proxy setting would carry is not used',
  () =>
    trackPiTestBody(
      (async () => {
        const base = await mkdtemp(join(tmpdir(), 'pi-relay-location-'))
        const home = join(base, 'home')
        const agentDir = join(home, '.pi', 'agent')
        const { result, seen, direct } = await run(
          base,
          agentDir,
          home,
          () => {
            process.env.PI_CODING_AGENT_DIR = agentDir
          },
          { fallbackToDirect: true, proxy: true },
        )
        expect(result.stopReason).toBe('stop')
        expect(seen).toEqual([])
        expect(direct).toEqual([`Bearer ${BEARER}`])
      })(),
    ),
  25_000,
)
