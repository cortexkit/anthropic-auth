import { afterEach, describe, expect, mock, test } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  custodyCredentialId,
  custodyTombstoneOAuth,
  getAccountStatePath,
  loadAccounts,
  saveAccounts,
  setClaustrumModePersistent,
  setRoutingMode,
} from '@cortexkit/anthropic-auth-core'
import { login } from '../cli'
import { runClaustrumTakeoverCommand } from '../custody-live'
import { AnthropicAuthPlugin } from '../index'
import {
  buildAccountDialogL1,
  normalizeAccountDialogPayload,
} from '../tui/command-dialogs'
import {
  bootRuledClaustrumRow as bootSharedRuledClaustrumRow,
  connectorFor,
  credentialResponse,
  ruledMainHandle,
  writeManifest,
} from './custody-ruled-row.fixture'
import { extractUrl, MESSAGES_URL, TOKEN_URL } from './test-fetch'

const originalFetch = globalThis.fetch
const originalEnv = {
  account: process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
  sidebar: process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE,
  feed: process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR,
  manifest: process.env.CLAUSTRUM_OPENCODE_HANDLES,
}
const roots: string[] = []

function restoreEnv(name: keyof typeof originalEnv, variable: string) {
  const value = originalEnv[name]
  if (value === undefined) delete process.env[variable]
  else process.env[variable] = value
}

async function expectMissing(path: string) {
  await expect(access(path)).rejects.toThrow()
}

async function createFirstRunRoot() {
  const root = await mkdtemp(join(tmpdir(), 'custody-first-run-'))
  roots.push(root)
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(root, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    root,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(root, 'quota-feed')
  return root
}

function createClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: {
      promptAsync: mock(
        (_input: { body: { parts: Array<{ text?: string }> } }) =>
          Promise.resolve(),
      ),
    },
  }
}

async function commandText(
  client: ReturnType<typeof createClient>,
  plugin: any,
) {
  await plugin['command.execute.before']({
    command: 'claude-account',
    arguments: '',
    sessionID: 'custody-first-run-status',
  }).catch(() => {})
  return (
    client.session.promptAsync.mock.calls.at(-1)?.[0]?.body.parts[0]?.text ?? ''
  )
}

async function bootRuled(
  options: Omit<
    Parameters<typeof bootSharedRuledClaustrumRow>[0],
    | 'createFallbackStorage'
    | 'useTempAccountFile'
    | 'getPlugin'
    | 'extractUrl'
    | 'tempConfigDir'
  >,
) {
  const root = await createFirstRunRoot()
  const client = createClient()
  const fixture = await bootSharedRuledClaustrumRow({
    ...options,
    createFallbackStorage: (storage) => ({ version: 1, ...storage }) as never,
    useTempAccountFile: async (storage) => {
      await saveAccounts(storage, process.env.OPENCODE_ANTHROPIC_AUTH_FILE!)
    },
    getPlugin: async (accountPath, runtime) =>
      (
        AnthropicAuthPlugin as unknown as (
          ctx: { client: unknown },
          runtime: Record<string, unknown>,
        ) => Promise<any>
      )({ client }, { ...runtime, claustrumNow: runtime.claustrumNow }),
    extractUrl,
    tempConfigDir: () => root,
  })
  return { ...fixture, client }
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  restoreEnv('account', 'OPENCODE_ANTHROPIC_AUTH_FILE')
  restoreEnv('sidebar', 'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE')
  restoreEnv('feed', 'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR')
  restoreEnv('manifest', 'CLAUSTRUM_OPENCODE_HANDLES')
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('fresh install under Claustrum', () => {
  test('fresh rostered fallback must route vault-first: accounts.ts:562 rejects no-state OAuth rows; custody-dimensions.ts:65-72 calls it R; accounts.ts:4234-4238 withholds non-resident vault rows; observed [Bearer vault-main-access, Bearer vault-main-access]', async () => {
    const root = await createFirstRunRoot()
    const accountPath = process.env.OPENCODE_ANTHROPIC_AUTH_FILE!
    const statePath = accountPath.replace(/\.json$/, '-state.json')
    const sidebarPath = process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE!
    await expectMissing(accountPath)
    await expectMissing(statePath)
    await saveAccounts(
      {
        version: 1,
        accounts: [
          { id: 'work-alt', label: 'work-alt', type: 'oauth', enabled: true },
        ],
      } as never,
      accountPath,
    )
    await setClaustrumModePersistent('claustrum', accountPath)
    await rm(statePath, { force: true })
    await expectMissing(statePath)

    const fallbackHandle = `ckh_${'F'.repeat(43)}`
    await writeManifest(root, [
      { label: 'main', handle: ruledMainHandle },
      { label: 'work-alt', handle: fallbackHandle },
    ])
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const authorizations: string[] = []
    let tokenRequests = 0
    globalThis.fetch = mock((input: unknown, init?: RequestInit) => {
      const url = extractUrl(input as Parameters<typeof extractUrl>[0])
      if (url === TOKEN_URL) tokenRequests++
      if (url.includes('/v1/messages')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const client = createClient()
    const plugin = await (
      AnthropicAuthPlugin as unknown as (
        ctx: { client: unknown },
        runtime: Record<string, unknown>,
      ) => Promise<any>
    )(
      { client },
      {
        claustrumNow: () => 1_000,
        claustrumConnector: connectorFor(calls, (method, params) => {
          if (method !== 'credential.get') return { result: {} }
          const isMain = params.handle === ruledMainHandle
          return credentialResponse(
            isMain ? 'vault-main-access' : 'vault-fallback-access',
            isMain ? 3 : 7,
            20_000_000,
            isMain ? 'A' : 'B',
          )
        }),
      },
    )
    try {
      const result = await plugin.auth.loader(
        () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
        { models: {} },
      )
      await plugin.__fallbackRefreshReady
      const mainResponse = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      await setRoutingMode('fallback-first', accountPath)
      const fallbackResult = await plugin.auth.loader(
        () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
        { models: {} },
      )
      const fallbackResponse = await fallbackResult.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      const storage = await loadAccounts(accountPath)
      const status = await commandText(client, plugin)
      const sidebar = await readFile(sidebarPath, 'utf8')
      expect(mainResponse.status).toBe(200)
      expect(fallbackResponse.status).toBe(200)
      expect(tokenRequests).toBe(0)
      expect(storage?.mainAccountId).toBeDefined()
      expect(storage?.routing?.mode).toBe('fallback-first')
      expect(storage?.accounts.map((account) => account.id)).toContain(
        'work-alt',
      )
      expect(
        calls
          .filter((call) => call.method === 'credential.get')
          .map((call) => call.params.handle),
      ).toContain(fallbackHandle)
      expect(authorizations).toEqual([
        'Bearer vault-main-access',
        'Bearer vault-fallback-access',
      ])
      expect(status).toContain('Custody mode: claustrum')
      expect(status).toContain('vault-served')
      expect(sidebar).toContain('work-alt')
      const publicOutput = `${status}\n${sidebar}`
      expect(publicOutput).not.toContain(ruledMainHandle)
      expect(publicOutput).not.toContain(fallbackHandle)
    } finally {
      await plugin.dispose?.()
    }
  })
})

describe('mixed-version account-dialog payloads', () => {
  test('renders an unavailable custody mode for a v1.22-shaped payload', () => {
    const payload = normalizeAccountDialogPayload({
      accounts: [
        {
          id: 'work-alt',
          label: 'work-alt',
          role: 'fallback',
          enabled: true,
          quotaPercent: null,
          claustrumGate: 'on',
          vaultServed: false,
          custodyState: 'on-cold',
        },
      ],
      claustrumDetection: 'ready',
    })

    expect(buildAccountDialogL1(payload).header).toBe(
      'Custody mode: unavailable from older server',
    )
    expect(JSON.stringify(payload)).not.toContain('ckh_')
  })

  test('accepts the v1.22 field subset from a current payload', () => {
    const currentPayload = {
      accounts: [
        {
          id: 'work-alt',
          label: 'work-alt',
          role: 'fallback',
          enabled: true,
          quotaPercent: 10,
          claustrumGate: 'on',
          vaultServed: true,
          vaultReauth: false,
          custodyState: 'on-vault-served',
        },
      ],
      claustrumDetection: 'ready',
      custodyMode: 'claustrum',
      custodyModeKnown: true,
    }
    const {
      custodyMode: _mode,
      custodyModeKnown: _known,
      ...v122
    } = currentPayload

    expect(() => normalizeAccountDialogPayload(v122)).not.toThrow()
  })
})

describe('cold main and warm fallback', () => {
  test.serial(
    'uses the warm fallback and never sends a tombstone bearer',
    async () => {
      const fallbackHandle = `ckh_${'C'.repeat(43)}`
      const fixture = await bootRuled({
        route: 'main-exhausted',
        initialNow: 1_000,
        fallbacks: [
          {
            label: 'work-alt',
            handle: fallbackHandle,
            access: 'vault-fallback',
          },
        ],
        connector: (calls) =>
          connectorFor(calls, (method, params) => {
            if (method !== 'credential.get') return { result: {} }
            return credentialResponse(
              params.handle === ruledMainHandle
                ? 'vault-main'
                : 'vault-fallback',
              7,
              params.handle === ruledMainHandle ? 2_000 : 10_000,
            )
          }),
      })
      try {
        fixture.setNow(3_000)
        const response = await fixture.result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        })
        expect(response.status).toBe(200)
        expect(fixture.authorizations).toEqual(['Bearer vault-fallback'])
        expect(fixture.authorizations.join('\n')).not.toContain(
          'claustrum-tombstone',
        )
      } finally {
        await fixture.plugin.dispose?.()
      }
    },
  )

  // Covered by index.test.ts 'a cold main with no fallback keeps the typed refusal'.
})

describe('401 provenance', () => {
  test.serial(
    'reports the served v7 record exactly once while it remains resident',
    async () => {
      const fallbackHandle = `ckh_${'P'.repeat(43)}`
      const fixture = await bootRuled({
        route: 'fallback-first',
        initialNow: 1_000,
        fallbacks: [
          {
            label: 'work-alt',
            handle: fallbackHandle,
            access: 'vault-fallback-v7',
          },
        ],
        connector: (calls) =>
          connectorFor(calls, (method, params) => {
            if (method !== 'credential.get') return { result: {} }
            return credentialResponse(
              params.handle === ruledMainHandle
                ? 'vault-main'
                : 'vault-fallback-v7',
              params.handle === ruledMainHandle ? 3 : 7,
              20_000_000,
            )
          }),
        onFetch: (input, init) =>
          new Headers(init?.headers).get('authorization') ===
          'Bearer vault-fallback-v7'
            ? new Response('{}', { status: 401 })
            : new Response('{}', { status: 200 }),
      })
      try {
        expect(
          (
            await fixture.result.fetch(MESSAGES_URL, {
              method: 'POST',
              body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
            })
          ).status,
        ).toBe(200)
        expect(
          fixture.calls.filter(
            (call) => call.method === 'credential.report_auth_failure',
          ),
        ).toEqual([
          {
            method: 'credential.report_auth_failure',
            params: {
              handle: fallbackHandle,
              provider_status: 401,
              record_version: 7,
              reporter_source: 'direct',
            },
          },
        ])
      } finally {
        await fixture.plugin.dispose?.()
      }
    },
  )

  test.serial(
    'suppresses a raced v7 report after the resident cache advances to v8',
    async () => {
      const fallbackHandle = `ckh_${'Q'.repeat(43)}`
      let recordVersion = 7
      let cache: any
      const fixture = await bootRuled({
        route: 'fallback-first',
        initialNow: 1_000,
        fallbacks: [
          {
            label: 'work-alt',
            handle: fallbackHandle,
            access: 'vault-fallback-v7',
          },
        ],
        connector: (calls) =>
          connectorFor(calls, (method, params) => {
            if (method !== 'credential.get') return { result: {} }
            return credentialResponse(
              params.handle === ruledMainHandle
                ? 'vault-main'
                : `vault-fallback-v${recordVersion}`,
              params.handle === ruledMainHandle ? 3 : recordVersion,
              20_000_000,
            )
          }),
        onFetch: async (_input, init) => {
          if (
            new Headers(init?.headers).get('authorization') ===
            'Bearer vault-fallback-v7'
          ) {
            // Suppress raced reports: the vault ignores them, but they still spend limiter capacity and create an audit anomaly.
            recordVersion = 8
            cache.invalidate(fallbackHandle, 7)
            await cache.get(fallbackHandle)
            return new Response('{}', { status: 401 })
          }
          return new Response('{}', { status: 200 })
        },
      })
      cache = fixture.plugin.__claustrumCredentialCache
      try {
        expect(
          (
            await fixture.result.fetch(MESSAGES_URL, {
              method: 'POST',
              body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
            })
          ).status,
        ).toBe(200)
        const reports = fixture.calls.filter(
          (call) => call.method === 'credential.report_auth_failure',
        )
        expect(reports).toEqual([])
        expect(JSON.stringify(reports)).not.toContain('record_version":8')
      } finally {
        await fixture.plugin.dispose?.()
      }
    },
  )

  test.serial(
    'does not report a local sidecar-served fallback 401',
    async () => {
      await createFirstRunRoot()
      const calls: Array<{ method: string; params: Record<string, unknown> }> =
        []
      await saveAccounts(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          claustrum: { mode: 'local' },
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'work-alt',
              label: 'work-alt',
              type: 'oauth',
              access: 'sidecar-access',
              refresh: 'sidecar-refresh',
              expires: Date.now() + 60_000,
            },
          ],
        } as never,
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
      )
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response('{}', { status: 401 })),
      ) as unknown as typeof fetch
      const plugin = await (
        AnthropicAuthPlugin as unknown as (
          ctx: { client: unknown },
          runtime: Record<string, unknown>,
        ) => Promise<any>
      )(
        { client: createClient() },
        { claustrumConnector: connectorFor(calls, () => ({ result: {} })) },
      )
      try {
        const result = await plugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: 'main-access',
              refresh: 'main-refresh',
              expires: Date.now() + 60_000,
            } as never),
          { models: {} },
        )
        expect(
          (
            await result.fetch(MESSAGES_URL, {
              method: 'POST',
              body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
            })
          ).status,
        ).toBe(401)
        expect(
          calls.filter(
            (call) => call.method === 'credential.report_auth_failure',
          ),
        ).toEqual([])
      } finally {
        await plugin.dispose?.()
      }
    },
  )
})

describe('exit and terminating re-login', () => {
  test.serial(
    'leaves custody before refusing a tombstoned main without refreshing',
    async () => {
      const root = await createFirstRunRoot()
      const missingParentPath = join(root, 'missing', 'anthropic-auth.json')
      await runClaustrumTakeoverCommand(
        { storagePath: missingParentPath, now: () => 1_000 } as never,
        'local',
      )
      expect(
        JSON.parse(await readFile(missingParentPath, 'utf8')).claustrum?.mode,
      ).toBe('local')
      let tokenRequests = 0
      let localPlugin: any
      const fixture = await bootRuled({
        route: 'fallback-first',
        fallbacks: [
          {
            label: 'work-alt',
            handle: `ckh_${'L'.repeat(43)}`,
            access: 'vault-fallback',
          },
        ],
        onFetch: (input) => {
          if (extractUrl(input as string | URL | Request) === TOKEN_URL)
            tokenRequests += 1
          return new Response('{}', { status: 200 })
        },
      })
      try {
        await fixture.plugin['command.execute.before']({
          command: 'claude-account',
          arguments: 'local',
          sessionID: 'custody-exit',
        }).catch(() => {})
        expect(
          (await loadAccounts(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!))
            ?.claustrum?.mode,
        ).toBe('local')

        await fixture.plugin.dispose?.()
        localPlugin = await (
          AnthropicAuthPlugin as unknown as (
            ctx: { client: unknown },
            runtime: Record<string, unknown>,
          ) => Promise<any>
        )(
          { client: createClient() },
          { claustrumConnector: connectorFor([], () => ({ result: {} })) },
        )
        let rejection: unknown
        try {
          const result = await localPlugin.auth.loader(
            () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
            { models: {} },
          )
          const response = await result.fetch(MESSAGES_URL, {
            method: 'POST',
            body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
          })
          rejection = await response.text()
        } catch (error) {
          rejection = error
        }
        expect(String(rejection)).toContain('REMAIN_DARK_PENDING_LOGIN')
        expect(tokenRequests).toBe(0)
        expect(fixture.authorizations.join('\n')).not.toContain(
          'claustrum-tombstone',
        )
      } finally {
        await localPlugin?.dispose?.()
        await fixture.plugin.dispose?.()
      }
    },
  )

  test.serial(
    'test(custody): a fresh local login re-admits a bound label after the exit',
    async () => {
      const label = 'work-alt'
      const handle = `ckh_${'N'.repeat(43)}`
      const access = 'new-local-access'
      const refresh = 'new-local-refresh'
      let localPlugin: any
      let tokenRequests = 0
      const tokenRequestBodies: string[] = []
      const authorize = mock(() =>
        Promise.resolve({
          url: 'https://example.test/oauth?state=state',
          redirectUri: 'https://example.test/callback',
          state: 'state',
          verifier: 'verifier',
        }),
      )
      const fixture = await bootRuled({
        route: 'fallback-first',
        fallbacks: [
          { label, handle, access: 'vault-fallback', account: { id: label } },
        ],
        onFetch: (input, init) => {
          if (extractUrl(input as string | URL | Request) === TOKEN_URL) {
            tokenRequests += 1
            tokenRequestBodies.push(String(init?.body))
            return Response.json({
              access_token: access,
              refresh_token: refresh,
              expires_in: 5 * 60 * 60,
            })
          }
          return new Response('{}', { status: 200 })
        },
      })
      try {
        const execute = async (arguments_: string) => {
          let handled = false
          await fixture.plugin['command.execute.before']({
            command: 'claude-account',
            arguments: arguments_,
            sessionID: 'custody-terminating-relogin',
          }).catch((error: unknown) => {
            handled = String(error).includes(
              '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__',
            )
            if (!handled) throw error
          })
          expect(handled).toBe(true)
        }
        await execute('local')
        tokenRequests = 0
        await login(label, {
          authorize,
          prompt: async () => 'code#state',
        })
        const storage = await loadAccounts(
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        )
        const fallback = storage?.accounts.find(
          (account) => account.label === label,
        )
        const state = JSON.parse(
          await readFile(
            getAccountStatePath(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!),
            'utf8',
          ),
        )
        const manifest = JSON.parse(
          await readFile(fixture.manifestPath, 'utf8'),
        )
        expect(fallback).toEqual(
          expect.objectContaining({
            access,
            refresh,
            authLineageId: expect.any(String),
          }),
        )
        expect(state.accounts[fallback!.id]).toEqual(
          expect.objectContaining({
            access,
            refresh,
            authLineageId: expect.any(String),
          }),
        )
        expect(manifest.providers[0].accounts).not.toContainEqual(
          expect.objectContaining({ label }),
        )

        await fixture.plugin.dispose?.()
        localPlugin = await (
          AnthropicAuthPlugin as unknown as (
            ctx: { client: unknown },
            runtime: Record<string, unknown>,
          ) => Promise<any>
        )({ client: createClient() }, {})
        const localResult = await localPlugin.auth.loader(
          () =>
            Promise.resolve({
              type: 'oauth',
              access: 'main-local-access',
              refresh: 'main-local-refresh',
              expires: Date.now() + 60_000,
            } as never),
          { models: {} },
        )
        await localResult.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        })
        expect(fixture.authorizations).toEqual([`Bearer ${access}`])
        expect(tokenRequests).toBe(1)
        expect(JSON.parse(tokenRequestBodies[0] ?? '{}')).toMatchObject({
          grant_type: 'authorization_code',
          code: 'code',
          state: 'state',
        })
      } finally {
        await localPlugin?.dispose?.()
        await fixture.plugin.dispose?.()
      }
    },
  )

  test.serial(
    'test(custody): re-entering claustrum needs a fresh vault binding for a re-logged label',
    async () => {
      const label = 'work-alt'
      const handle = `ckh_${'R'.repeat(43)}`
      const access = 'new-local-access'
      const refresh = 'new-local-refresh'
      let fallbackRecordVersion = 7
      const authorize = mock(() =>
        Promise.resolve({
          url: 'https://example.test/oauth?state=state',
          redirectUri: 'https://example.test/callback',
          state: 'state',
          verifier: 'verifier',
        }),
      )
      const fixture = await bootRuled({
        route: 'fallback-first',
        initialNow: 1_000,
        fallbacks: [
          { label, handle, access: 'vault-fallback', account: { id: label } },
        ],
        connector: (calls) =>
          connectorFor(calls, (method, params) => {
            if (method !== 'credential.get') return { result: {} }
            const main = params.handle === ruledMainHandle
            return credentialResponse(
              main ? 'vault-main-access' : 'vault-fallback-access',
              main ? 3 : fallbackRecordVersion,
              20_000_000,
              undefined,
              main ? custodyCredentialId('main') : custodyCredentialId(label),
            )
          }),
        onFetch: (input) => {
          if (extractUrl(input as string | URL | Request) === TOKEN_URL) {
            return Response.json({
              access_token: access,
              refresh_token: refresh,
              expires_in: 5 * 60 * 60,
            })
          }
          return new Response('{}', { status: 200 })
        },
      })
      try {
        const execute = async (arguments_: string) => {
          let handled = false
          await fixture.plugin['command.execute.before']({
            command: 'claude-account',
            arguments: arguments_,
            sessionID: 'custody-reentry',
          }).catch((error: unknown) => {
            handled = String(error).includes(
              '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__',
            )
            if (!handled) throw error
          })
          expect(handled).toBe(true)
          return (
            fixture.client.session.promptAsync.mock.calls.at(-1)?.[0]?.body
              .parts[0]?.text ?? ''
          )
        }

        await execute('local')
        await login(label, {
          authorize,
          prompt: async () => 'code#state',
        })
        const refusal = await execute('claustrum')
        const localStorage = await loadAccounts(
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        )
        expect(refusal).toContain('binding_missing')
        expect(refusal).toContain(label)
        expect(localStorage?.claustrum?.mode).toBe('local')

        await writeManifest(dirname(fixture.manifestPath), [
          { label: 'main', handle: ruledMainHandle },
          { label, handle },
        ])
        fallbackRecordVersion = 8
        const reentered = await execute('claustrum')
        const storage = await loadAccounts(
          process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        )
        const state = JSON.parse(
          await readFile(
            getAccountStatePath(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!),
            'utf8',
          ),
        )
        expect(reentered).toContain(
          'Claustrum custody committed for: main, work-alt.',
        )
        expect(storage?.claustrum?.mode).toBe('claustrum')
        const result = await fixture.plugin.auth.loader(
          () => Promise.resolve(custodyTombstoneOAuth('anthropic') as never),
          { models: {} },
        )
        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
        })
        expect(fixture.authorizations).toContain('Bearer vault-fallback-access')
        expect(state.accounts[label]).toEqual(
          expect.objectContaining({
            access: '',
            refresh: expect.stringContaining('claustrum-tombstone'),
          }),
        )
      } finally {
        await fixture.plugin.dispose?.()
      }
    },
  )
})
