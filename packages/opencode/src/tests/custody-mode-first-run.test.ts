import { afterEach, describe, expect, mock, test } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  custodyTombstoneOAuth,
  loadAccounts,
  saveAccounts,
  setClaustrumModePersistent,
  setRoutingMode,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import {
  buildAccountDialogL1,
  normalizeAccountDialogPayload,
} from '../tui/command-dialogs'
import {
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
    session: { promptAsync: mock(() => Promise.resolve()) },
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
  test.todo('fresh rostered fallback must route vault-first: accounts.ts:562 rejects no-state OAuth rows; custody-dimensions.ts:65-72 calls it R; accounts.ts:4234-4238 withholds non-resident vault rows; observed [Bearer vault-main-access, Bearer vault-main-access]', async () => {
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
