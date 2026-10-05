import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  type ClaustrumScopedClient,
  getAccountStatePath,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'

const testDirs: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const d of testDirs.splice(0)) {
    await rm(d, { recursive: true, force: true })
  }
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
  delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
})

const PRIMARY_ACCOUNT_ID = 'e84ca8b4-bd13-41e9-98e4-13f7b6690b7e'
const SLOT_ID = '874a76c0-309a-4ccb-9199-9106db83f521'

const mainRow: ScopedInventoryRow = {
  id: 'oauth:anthropic',
  accountId: PRIMARY_ACCOUNT_ID,
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

async function readMainQuota(storagePath: string) {
  const state = JSON.parse(
    await readFile(getAccountStatePath(storagePath), 'utf8'),
  ) as {
    main?: {
      quota?: {
        accountIdentity?: string
        scoped?: Array<{ id?: string }>
      }
    }
  }
  return state.main?.quota
}

async function setupScopedSeat(root: string) {
  const storagePath = join(root, 'anthropic-auth.json')
  const tokenPath = join(root, 'opencode-enrollment.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    root,
    'sidebar.json',
  )
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const initialStorage: AccountStorage = {
    version: 1,
    mainAccountId: SLOT_ID,
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: mainRow.id,
        accountId: PRIMARY_ACCOUNT_ID as any,
        state: 'active',
      },
    },
    accounts: [],
  }
  await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), {
    mode: 0o600,
  })
  return storagePath
}

const scopedClient: ClaustrumScopedClient = {
  listScoped: async () => ({ view: 'view-1', rows: [mainRow] }),
  getScoped: async (input) => ({
    credentialId: input.credentialId,
    accountId: PRIMARY_ACCOUNT_ID,
    material: 'scoped-access-main',
    recordVersion: 10,
    expiresAtMs: Date.now() + 3_600_000,
  }),
  reportAuthFailureScoped: async () => {},
  close: () => {},
}

const TOMBSTONE_AUTH = () =>
  Promise.resolve({
    type: 'oauth',
    access: '',
    refresh: 'claustrum-tombstone:v1:anthropic',
    expires: 0,
  })

test('/claude-quota polls main through scoped custody and persists its scoped windows', async () => {
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-quota-cmd-'))
  testDirs.push(root)
  const storagePath = await setupScopedSeat(root)
  const usageAuthorizations: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/oauth/usage')) {
      usageAuthorizations.push(
        new Headers(init?.headers).get('authorization') ?? '',
      )
      return Response.json({
        five_hour: { utilization: 40, resets_at: null },
        seven_day: { utilization: 13, resets_at: null },
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 22,
            scope: {
              model: { id: 'claude-fable-5-1', display_name: 'Fable' },
            },
          },
        ],
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const plugin = await AnthropicAuthPlugin(
    { directory: root, client: { session: {} } } as any,
    { claustrumScopedConnect: async () => scopedClient } as any,
  )
  try {
    await (plugin as any).auth.loader(TOMBSTONE_AUTH, { models: {} } as any)
    await (plugin as any)
      ['command.execute.before']({
        command: 'claude-quota',
        arguments: '',
        sessionID: 'session-1',
      })
      .catch(() => {})
    await drainSidebarWrites()
    expect(usageAuthorizations).toContain('Bearer scoped-access-main')
    let quota = await readMainQuota(storagePath)
    for (let i = 0; i < 60 && !quota?.scoped; i++) {
      await Bun.sleep(50)
      quota = await readMainQuota(storagePath)
    }
    expect(quota?.accountIdentity).toBe(PRIMARY_ACCOUNT_ID)
    expect(quota?.scoped?.map((window) => window.id)).toEqual([
      'claude-weekly-scoped-claude-fable-5-1',
    ])
  } finally {
    await plugin.dispose?.()
  }
})

test('scoped custody persists main quota under the roster primary account id', async () => {
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-main-quota-'))
  testDirs.push(root)
  const storagePath = join(root, 'anthropic-auth.json')
  const tokenPath = join(root, 'opencode-enrollment.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    root,
    'sidebar.json',
  )
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'aa'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  // A migrated seat keeps its pre-scoped local slot id, which differs from
  // the provider account id the scoped roster binds main state to.
  const initialStorage: AccountStorage = {
    version: 1,
    mainAccountId: SLOT_ID,
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: mainRow.id,
        accountId: PRIMARY_ACCOUNT_ID as any,
        state: 'active',
      },
    },
    accounts: [],
  }
  await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), {
    mode: 0o600,
  })

  const scopedClient: ClaustrumScopedClient = {
    listScoped: async () => ({ view: 'view-1', rows: [mainRow] }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: PRIMARY_ACCOUNT_ID,
      material: 'scoped-access-main',
      recordVersion: 10,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }

  const resetSeconds = Math.floor(Date.now() / 1000) + 3_600
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/oauth/usage')) {
      return Response.json({
        five_hour: { utilization: 40 },
        seven_day: { utilization: 13 },
      })
    }
    if (url.includes('/v1/messages')) {
      return new Response(
        '{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}',
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-utilization': '0.4',
            'anthropic-ratelimit-unified-5h-reset': String(resetSeconds),
            'anthropic-ratelimit-unified-7d-utilization': '0.13',
            'anthropic-ratelimit-unified-7d-reset': String(
              resetSeconds + 86_400,
            ),
          },
        },
      )
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const plugin = await AnthropicAuthPlugin(
    { directory: root } as any,
    {
      claustrumScopedConnect: async () => scopedClient,
    } as any,
  )
  try {
    const result = await (plugin as any).auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
        }),
      { models: {} } as any,
    )
    const response = await result.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      },
    )
    expect(response.status).toBe(200)
    await response.text()

    let quota = await readMainQuota(storagePath)
    for (let i = 0; i < 60 && !quota; i++) {
      await Bun.sleep(50)
      quota = await readMainQuota(storagePath)
    }
    await drainSidebarWrites()
    expect(quota).toBeDefined()
    expect(quota?.accountIdentity).toBe(PRIMARY_ACCOUNT_ID)
  } finally {
    await plugin.dispose?.()
  }
})

test('a scoped main receipt never binds its quota to a roster primary that changed mid-request', async () => {
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-primary-race-'))
  testDirs.push(root)
  const storagePath = await setupScopedSeat(root)
  const NEW_PRIMARY = '11111111-2222-4333-8444-555555555555'

  let getScopedCalls = 0
  const racingClient: ClaustrumScopedClient = {
    listScoped: async () => ({ view: 'view-1', rows: [mainRow] }),
    getScoped: async (input) => {
      getScopedCalls += 1
      // The roster primary moves to B after the plugin authorized main but
      // before the receipt for A is used to bind quota.
      if (getScopedCalls === 1) {
        const stored = JSON.parse(await readFile(storagePath, 'utf8'))
        stored.claustrum.primaryAccount.accountId = NEW_PRIMARY
        await writeFile(storagePath, JSON.stringify(stored, null, 2), {
          mode: 0o600,
        })
      }
      return {
        credentialId: input.credentialId,
        accountId: PRIMARY_ACCOUNT_ID,
        material: 'scoped-access-main',
        recordVersion: 10,
        expiresAtMs: Date.now() + 3_600_000,
      }
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }

  const resetSeconds = Math.floor(Date.now() / 1000) + 3_600
  const messageAuthorizations: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/v1/messages')) {
      messageAuthorizations.push(
        new Headers(init?.headers).get('authorization') ?? '',
      )
      return new Response(
        '{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}',
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-utilization': '0.4',
            'anthropic-ratelimit-unified-5h-reset': String(resetSeconds),
            'anthropic-ratelimit-unified-7d-utilization': '0.13',
            'anthropic-ratelimit-unified-7d-reset': String(
              resetSeconds + 86_400,
            ),
          },
        },
      )
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const plugin = await AnthropicAuthPlugin(
    { directory: root } as any,
    {
      claustrumScopedConnect: async () => racingClient,
    } as any,
  )
  try {
    const result = await (plugin as any).auth.loader(TOMBSTONE_AUTH, {
      models: {},
    } as any)
    let requestError: unknown
    const response = await result
      .fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      .catch((error: unknown) => {
        requestError = error
        return undefined
      })
    await response?.text().catch(() => {})
    await Bun.sleep(300)
    await drainSidebarWrites()

    // The race really happened: A's receipt was served and the roster primary
    // moved to B while it was in flight.
    expect(getScopedCalls).toBeGreaterThan(0)
    const stored = JSON.parse(await readFile(storagePath, 'utf8'))
    expect(stored.claustrum.primaryAccount.accountId).toBe(NEW_PRIMARY)
    // The request failed closed on the identity fence before sending A's
    // bearer, instead of failing for an unrelated reason.
    expect(String(requestError)).toContain('Main OAuth identity changed')
    expect(messageAuthorizations).toEqual([])
    // And A's quota was never bound to B.
    const quota = await readMainQuota(storagePath)
    expect(quota?.accountIdentity).not.toBe(NEW_PRIMARY)
  } finally {
    await plugin.dispose?.()
  }
})
