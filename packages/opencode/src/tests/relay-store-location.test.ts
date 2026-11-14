// A relay is honoured only from the account store in its default place for
// the operating system account. These tests move the store with one
// environment variable, as a repository's `.env` could, and check that the
// bearer custody hands out is sent directly to Anthropic and never to the
// relay the moved store names.
import { afterEach, describe, expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  custodyTombstoneOAuth,
  type NativeCustodyClient,
  TEST_RELAY_ACCOUNT_HOME_KEY,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>

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
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'ANTHROPIC_AUTH_SETTINGS_FILE',
  'CORTEXKIT_VAULT_HOST',
] as const

const live = new Set<PluginHooks>()
afterEach(async () => {
  await Promise.allSettled([...live].map((plugin) => plugin.dispose?.()))
  live.clear()
})
const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test
const hook = globalThis as unknown as Record<symbol, unknown>
const vaultKey = Symbol.for('cortexkit.vault')

async function startBody(prefix: string) {
  const savedFetch = globalThis.fetch
  const saved = new Map(envKeys.map((key) => [key, process.env[key]]))
  const prior = hook[vaultKey]
  lifetimes.deferCleanup(async () => {
    await Promise.allSettled([...live].map((plugin) => plugin.dispose?.()))
    live.clear()
    await drainSidebarWrites()
    globalThis.fetch = savedFetch
    for (const key of envKeys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (prior === undefined) delete hook[vaultKey]
    else hook[vaultKey] = prior
    core.resetVaultHostAuthorityForTests?.()
  })
  delete process.env.OPENCODE_AUTH_CONTENT
  const base = await mkdtemp(join(tmpdir(), prefix))
  lifetimes.deferCleanup(() => rm(base, { recursive: true, force: true }))
  return base
}

async function ownerDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  return path
}

const mainRow: ScopedInventoryRow = {
  id: 'oauth:anthropic',
  accountId: 'provider-main-uuid',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 10,
  createdAtMs: null,
}

function scopedLegacyConfig(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    accounts: [],
    quota: { enabled: false },
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: mainRow.id,
        accountId: mainRow.accountId,
        state: 'active',
      },
    },
    ...extra,
  }
}

function discovery(): NativeCustodyClient {
  return {
    async listScoped() {
      return {
        view: 'migration-discovery',
        rows: [mainRow],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      throw new Error('discovery must not read material')
    },
    async reportAuthFailureScoped() {},
    close() {},
  }
}

const BEARER = 'VICTIM-REAL-VAULT-BEARER'

/** The user's vault: it hands out the user's real bearer. */
function userVault(): NativeCustodyClient {
  return {
    listScoped: async () => ({
      view: 'main-only',
      rows: [mainRow],
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async ({ credentialId }) => ({
      credentialId,
      accountId: mainRow.accountId,
      material: BEARER,
      recordVersion: 10,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
}

/** A loopback relay that records the upstream bearer of each request. */
function loopbackRelay() {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const text = await request.text()
      let bearer = '<unparsed>'
      try {
        bearer =
          (
            JSON.parse(text) as {
              upstream?: { headers?: Record<string, string> }
            }
          ).upstream?.headers?.authorization ?? '<none>'
      } catch {}
      seen.push(bearer)
      return new Response('relayed', { status: 200 })
    },
  })
  lifetimes.deferCleanup(() => server.stop(true))
  return { seen, url: `http://127.0.0.1:${server.port}/forward` }
}

function relaySettings(url: string) {
  return {
    relay: {
      enabled: true,
      transport: 'http',
      url,
      token: 'relay-token',
      fallbackToDirect: false,
    },
  }
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/**
 * Sends loopback traffic for real and answers Anthropic model requests as a
 * mock, recording each direct request's bearer.
 */
function mockAnthropic() {
  const direct: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('http://127.0.0.1:'))
      return realFetch(input as string, init)
    if (url.startsWith(MESSAGES_URL)) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      direct.push(headers.get('authorization') ?? '<none>')
      return Response.json({
        id: 'msg_direct',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'direct' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    throw new Error(`unexpected network call ${url}`)
  }) as typeof fetch
  return direct
}

async function send(hostAuthPath: string) {
  const creation = AnthropicAuthPlugin(
    { directory: tmpdir() } as never,
    {
      claustrumScopedConnect: async () => userVault(),
      scopedRosterPollIntervalMs: 0,
    } as never,
  )
  lifetimes.trackDetached(creation)
  const plugin = await creation
  live.add(plugin)
  const loader = await (
    plugin as unknown as {
      auth: {
        loader: (
          auth: () => Promise<unknown>,
          provider: unknown,
        ) => Promise<{ fetch: typeof fetch }>
      }
    }
  ).auth.loader(
    async () => JSON.parse(await readFile(hostAuthPath, 'utf8')).anthropic,
    { models: {} },
  )
  return loader.fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-affinity': 'relay-store-location',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
}

/**
 * The user's own install, enrolled in vault custody, in the default place
 * under `home`: `<home>/.config/opencode`. The OS account lookup is stubbed
 * to return `home`.
 */
async function userInstall(base: string, extra: Record<string, unknown> = {}) {
  const home = await ownerDir(join(base, 'home'))
  const user = await migrateNativeOpencodeFixture({
    root: await ownerDir(join(home, '.config', 'opencode')),
    lifetime: lifetimes,
    legacyConfig: scopedLegacyConfig(extra),
    hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
    custody: {
      connect: async () => discovery(),
      enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
    },
  })
  hook[TEST_RELAY_ACCOUNT_HOME_KEY] = () => home
  for (const [key, value] of Object.entries(user.env)) process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  process.env.XDG_STATE_HOME = await ownerDir(join(base, 'state'))
  delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  return { home, user }
}

/** Thalamus custody: no enrollment file; the host provides the user's bearer. */
function hostByThalamus() {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  core.resetVaultHostAuthorityForTests?.()
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  hook[vaultKey] = () => userVault()
}

describe('OpenCode 1: a relay named by a store moved with one variable is ignored', () => {
  for (const custody of ['vault', 'hosted'] as const)
    for (const variable of [
      'OPENCODE_ANTHROPIC_AUTH_FILE',
      'XDG_CONFIG_HOME',
      'OPENCODE_CONFIG_DIR',
    ] as const)
      test(`${custody} mode, store moved by ${variable}`, async () => {
        const base = await startBody('relay-store-location-')
        const relay = loopbackRelay()
        // A store prepared elsewhere (for example committed to a repository)
        // whose relay names the listener above. Only its store files are used.
        const otherXdg = await ownerDir(join(base, 'xdg'))
        const otherDir = await ownerDir(
          variable === 'XDG_CONFIG_HOME'
            ? join(otherXdg, 'opencode')
            : join(base, 'other'),
        )
        const other = await migrateNativeOpencodeFixture({
          root: otherDir,
          lifetime: lifetimes,
          legacyConfig: scopedLegacyConfig(relaySettings(relay.url)),
          hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
          custody: {
            connect: async () => discovery(),
            enrollment: { token: 'cd'.repeat(32), token_generation: 1 },
          },
        })
        const { user } = await userInstall(base)
        // The user's environment, except that one variable moves the store.
        delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
        if (variable === 'XDG_CONFIG_HOME') {
          // The test preload sets OPENCODE_CONFIG_DIR, which outranks XDG.
          delete process.env.OPENCODE_CONFIG_DIR
          process.env.XDG_CONFIG_HOME = otherXdg
        } else if (variable === 'OPENCODE_CONFIG_DIR')
          process.env.OPENCODE_CONFIG_DIR = otherDir
        else
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE =
            other.env.OPENCODE_ANTHROPIC_AUTH_FILE
        if (custody === 'hosted') hostByThalamus()
        const direct = mockAnthropic()
        const response = await send(user.hostAuthPath)
        expect(response.status).toBe(200)
        expect(relay.seen).toEqual([])
        expect(direct).toEqual([`Bearer ${BEARER}`])
      })

  test('vault mode, store in its default place: its relay is still used', async () => {
    const base = await startBody('relay-store-location-')
    const relay = loopbackRelay()
    const { user } = await userInstall(base, relaySettings(relay.url))
    const direct = mockAnthropic()
    const response = await send(user.hostAuthPath)
    expect(response.status).toBe(200)
    expect(relay.seen).toEqual([`Bearer ${BEARER}`])
    expect(direct).toEqual([])
  })
})
