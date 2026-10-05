import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  acquireRefreshFileLock,
  type ClaustrumScopedClient,
  getAccountStatePath,
  isOAuthAccount,
  type OAuthAccount,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites, getSidebarStateFile } from '../sidebar-state.ts'

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
  delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
})

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hello' }],
  }),
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

const workRow: ScopedInventoryRow = {
  id: 'oauth:anthropic:work',
  accountId: 'provider-work-uuid',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 5,
  createdAtMs: null,
}

describe('OpenCode scoped custody serving', () => {
  test('serves requests using scoped receipts and dynamically adopts newly logged-in accounts without restart', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-serving-'))
    testDirs.push(root)

    const storagePath = join(root, 'anthropic-auth.json')
    const tokenPath = join(root, 'opencode-enrollment.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = join(root, 'dumps')
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
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: mainRow.id,
          accountId: mainRow.accountId as any,
          state: 'active',
        },
      },
      dump: { enabled: true },
      accounts: [
        {
          id: 'work',
          label: 'work',
          type: 'oauth',
          enabled: true,
          refresh: '',
          claustrumScopedCredentialId: workRow.id,
          anthropicAccountUuid: workRow.accountId as any,
          claustrumScopedState: 'active',
        },
      ],
    }
    await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), {
      mode: 0o600,
    })

    const rows = [mainRow, workRow]
    const gets: Array<{ credentialId: string }> = []
    const reports: Array<{
      credentialId: string
      recordVersion: number
      providerStatus: number
    }> = []

    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({
        view: `view-${rows.length}`,
        rows: [...rows],
      }),
      getScoped: async (input) => {
        gets.push(input)
        const row = rows.find((r) => r.id === input.credentialId)
        return {
          credentialId: input.credentialId,
          accountId: row?.accountId ?? 'unknown',
          material: `scoped-access-${input.credentialId}`,
          recordVersion: row?.recordVersion ?? 1,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async (input) => {
        reports.push(input)
      },
      close: () => {},
    }

    const authorizations: string[] = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 10 },
        })
      }
      if (url.includes('/v1/messages')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return new Response(
          '{"id":"msg_1","type":"message","content":[{"type":"text","text":"hello"}]}',
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const plugin = await AnthropicAuthPlugin(
      {
        directory: root,
      } as any,
      { claustrumScopedConnect: async () => scopedClient } as any,
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

      // 1. Initial request dispatches with main scoped credential
      const firstResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
      expect(firstResponse.status).toBe(200)
      expect(authorizations).toHaveLength(1)
      expect(authorizations[0]).toBe('Bearer scoped-access-oauth:anthropic')
      expect(gets.some((g) => g.credentialId === 'oauth:anthropic')).toBe(true)
      await firstResponse.text()
      await drainSidebarWrites()
      const serialized = [
        await readFile(storagePath, 'utf8'),
        await readFile(getAccountStatePath(storagePath), 'utf8'),
        await readFile(getSidebarStateFile(), 'utf8'),
        ...(await Promise.all(
          (
            await readdir(process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR!)
          ).map((name) =>
            readFile(
              join(process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR!, name),
              'utf8',
            ),
          ),
        )),
      ].join('\n')
      expect(serialized).not.toContain('scoped-access-oauth:anthropic')
      expect(serialized).not.toContain('aa'.repeat(32))

      // 2. Simulate user adding a 3rd account via `ck auth login`
      const personalRow: ScopedInventoryRow = {
        id: 'oauth:anthropic:personal',
        accountId: 'provider-personal-uuid',
        categories: ['anthropic-native'],
        serves: ['anthropic'],
        providerIds: [],
        credentialType: 'oauth',
        refreshAdapter: 'anthropic',
        operations: ['read'],
        state: 'active',
        recordVersion: 1,
        createdAtMs: null,
      }
      rows.push(personalRow)

      // Trigger discovery refresh (simulating background poll)
      const runtime = (plugin as any).__scopedRuntime
      expect(runtime).toBeDefined()
      await runtime.refresh()

      // 3. Verify storage was updated with the new account
      const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
      const updatedStorage = await loadAccounts(storagePath)
      const personalAccount = updatedStorage?.accounts.find(
        (a): a is OAuthAccount =>
          isOAuthAccount(a) &&
          a.anthropicAccountUuid === 'provider-personal-uuid',
      )
      expect(personalAccount).toBeDefined()
      expect(personalAccount?.claustrumScopedCredentialId).toBe(
        'oauth:anthropic:personal',
      )
      expect(personalAccount?.claustrumScopedState).toBe('active')
    } finally {
      await plugin.dispose?.()
    }
  })

  test('reports upstream 401 auth failure to Claustrum with exact served record version', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-401-'))
    testDirs.push(root)

    const storagePath = join(root, 'anthropic-auth.json')
    const tokenPath = join(root, 'opencode-enrollment.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath

    await writeFile(
      tokenPath,
      JSON.stringify({ token: 'bb'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )

    const initialStorage: AccountStorage = {
      version: 1,
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: mainRow.id,
          accountId: mainRow.accountId as any,
          state: 'active',
        },
      },
      accounts: [],
    }
    await writeFile(storagePath, JSON.stringify(initialStorage, null, 2), {
      mode: 0o600,
    })

    const reports: Array<{
      credentialId: string
      recordVersion: number
      providerStatus: number
    }> = []
    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({ view: 'v1', rows: [mainRow] }),
      getScoped: async (input) => ({
        credentialId: input.credentialId,
        accountId: mainRow.accountId,
        material: 'revoked-token',
        recordVersion: 10,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async (input) => {
        reports.push(input)
      },
      close: () => {},
    }

    let modelSends = 0
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 10 },
        })
      }
      modelSends++
      return new Response(
        '{"type":"error","error":{"type":"authentication_error"}}',
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    const plugin = await AnthropicAuthPlugin(
      { directory: root } as any,
      { claustrumScopedConnect: async () => scopedClient } as any,
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

      await result.fetch(MESSAGES_URL, EMPTY_POST).catch(() => {})

      expect(modelSends).toBe(1)
      expect(reports).toHaveLength(1)
      expect(reports[0]).toMatchObject({
        credentialId: 'oauth:anthropic',
        recordVersion: 10,
        providerStatus: 401,
      })
    } finally {
      await plugin.dispose?.()
    }
  })
})

test('Claustrum mode without a scoped roster refuses to serve even with legacy local fallback material', async () => {
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  const root = await mkdtemp(join(tmpdir(), 'opencode-legacy-refusal-'))
  testDirs.push(root)
  const storagePath = join(root, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    root,
    'enrollment.json',
  )
  await writeFile(
    storagePath,
    JSON.stringify({
      version: 1,
      claustrum: { mode: 'claustrum' },
      accounts: [
        {
          id: 'old',
          label: 'old',
          type: 'oauth',
          enabled: true,
          access: 'stale-local-access',
          refresh: 'stale-local-refresh',
          expires: Date.now() + 3600000,
        },
      ],
    }),
    { mode: 0o600 },
  )
  let sends = 0
  globalThis.fetch = (async () => {
    sends++
    throw new Error('request must not reach upstream')
  }) as unknown as typeof fetch
  const plugin = await AnthropicAuthPlugin(
    { directory: root } as any,
    {
      scopedRosterPollIntervalMs: 0,
    } as any,
  )
  try {
    const loader = await (plugin as any).auth.loader(
      async () => ({
        type: 'oauth',
        access: '',
        refresh: 'claustrum-tombstone:v1:anthropic',
        expires: 0,
      }),
      { models: {} },
    )
    const response = await loader.fetch(MESSAGES_URL, EMPTY_POST)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain(
      'Run setup to enable scoped Claustrum custody',
    )
    expect(sends).toBe(0)
  } finally {
    await plugin.dispose?.()
  }
})

test('loader and model request remain usable when a peer holds the scoped roster lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-lease-'))
  testDirs.push(root)
  const storagePath = join(root, 'anthropic-auth.json')
  const tokenPath = join(root, 'opencode-enrollment.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'cc'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await writeFile(
    storagePath,
    JSON.stringify({
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
    }),
    { mode: 0o600 },
  )
  const lease = await acquireRefreshFileLock({
    name: 'scoped-roster',
    path: storagePath,
    ttlMs: 30_000,
    renew: true,
  })
  if (!lease) throw new Error('test could not acquire roster lease')
  let lists = 0,
    gets = 0,
    sends = 0
  const scopedClient: ClaustrumScopedClient = {
    listScoped: async () => {
      lists++
      throw new Error('peer owns discovery')
    },
    getScoped: async ({ credentialId }) => {
      gets++
      return {
        credentialId,
        accountId: mainRow.accountId,
        material: 'lease-scoped-access',
        recordVersion: 42,
        expiresAtMs: Date.now() + 3_600_000,
      }
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes('/v1/messages'))
      throw new Error('unexpected upstream call')
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer lease-scoped-access',
    )
    sends++
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  let plugin: Awaited<ReturnType<typeof AnthropicAuthPlugin>> | undefined
  try {
    plugin = await AnthropicAuthPlugin(
      { directory: root } as never,
      {
        claustrumScopedConnect: async () => scopedClient,
        scopedRosterPollIntervalMs: 0,
      } as never,
    )
    // OpenCode initializes plugins for all providers. A contested roster
    // must not make an unrelated model's provider initialization fail.
    const loader = await (plugin as any).auth.loader(
      async () => ({
        type: 'oauth',
        access: '',
        refresh: 'claustrum-tombstone:v1:anthropic',
        expires: 0,
      }),
      { models: {} },
    )
    expect(lists).toBe(0)
    expect(gets).toBe(0)
    expect((await loader.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
    expect(gets).toBeGreaterThan(0)
    expect(sends).toBe(1)
    expect(lists).toBe(0)
  } finally {
    await plugin?.dispose?.()
    await lease.release()
  }
})

test('provider initialization does not wait for a stalled scoped discovery connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-loader-'))
  testDirs.push(root)
  const storagePath = join(root, 'anthropic-auth.json')
  const tokenPath = join(root, 'opencode-enrollment.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  await writeFile(
    tokenPath,
    JSON.stringify({ token: 'dd'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await writeFile(
    storagePath,
    JSON.stringify({
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
    }),
    { mode: 0o600 },
  )
  let connectStarted!: () => void
  let releaseConnect!: (value: ClaustrumScopedClient) => void
  const entered = new Promise<void>((resolve) => {
    connectStarted = resolve
  })
  const blocked = new Promise<ClaustrumScopedClient>((resolve) => {
    releaseConnect = resolve
  })
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({ rows: [mainRow], view: 'v' }),
    getScoped: async () => {
      throw new Error('no dispatch expected')
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const plugin = await AnthropicAuthPlugin(
    { directory: root } as never,
    {
      claustrumScopedConnect: () => {
        connectStarted()
        return blocked
      },
      scopedRosterPollIntervalMs: 0,
    } as never,
  )
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await entered
    const loader = await Promise.race([
      (plugin as any).auth.loader(
        async () => ({
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
        }),
        { models: {} },
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error('provider initialization waited for scoped discovery'),
            ),
          1000,
        )
        deadline.unref?.()
      }),
    ])
    expect(loader.fetch).toBeFunction()
  } finally {
    if (deadline) clearTimeout(deadline)
    releaseConnect(client)
    await plugin.dispose?.()
  }
})

test.each([
  { outcome: '200', finalStatus: 200 },
  { outcome: '401', finalStatus: 401 },
  { outcome: 'network-error', finalStatus: 'network-error' },
] as const)(
  'a scoped main rotated during HTTP dispatch retries once, final outcome $outcome',
  async ({ finalStatus }) => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-rotation-'))
    testDirs.push(root)
    const storagePath = join(root, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      root,
      'enrollment.json',
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await writeFile(
      process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await writeFile(
      storagePath,
      JSON.stringify({
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
      }),
      { mode: 0o600 },
    )
    let version = 1
    const reports: number[] = []
    const wireTokens: string[] = []
    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => ({
        credentialId,
        accountId: mainRow.accountId,
        material: `scoped-version-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
      },
      close: () => {},
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!String(input).includes('/v1/messages'))
        throw new Error('unexpected upstream call')
      const token = new Headers(init?.headers).get('authorization') ?? ''
      wireTokens.push(token)
      if (token === 'Bearer scoped-version-1') {
        version = 2 // The vault rotates after getScoped, before Anthropic responds.
        return new Response('old token rejected', { status: 401 })
      }
      if (finalStatus === 'network-error')
        throw new Error('new record transport failed')
      return new Response('rotated token response', { status: finalStatus })
    }) as typeof fetch
    const plugin = await AnthropicAuthPlugin(
      { directory: root } as never,
      {
        claustrumScopedConnect: async () => scopedClient,
        scopedRosterPollIntervalMs: 0,
      } as never,
    )
    try {
      const loader = await (plugin as any).auth.loader(
        async () => ({
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
        }),
        { models: {} },
      )
      if (finalStatus === 'network-error') {
        await expect(loader.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
          'new record transport failed',
        )
      } else {
        const response = await loader.fetch(MESSAGES_URL, EMPTY_POST)
        expect(response.status).toBe(finalStatus)
        expect(await response.text()).toBe('rotated token response')
      }
      expect(wireTokens).toEqual([
        'Bearer scoped-version-1',
        'Bearer scoped-version-2',
      ])
      expect(reports).toEqual(finalStatus === 401 ? [2] : [])
    } finally {
      await plugin.dispose?.()
    }
  },
)

test.each(['transport-error', 'relay-auth-401'] as const)(
  'relay-to-direct after %s reauthorizes and reports only the direct credential',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-relay-direct-'))
    testDirs.push(root)
    const storagePath = join(root, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      root,
      'enrollment.json',
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await writeFile(
      process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 1,
        accounts: [],
        quota: { enabled: false },
        relay: {
          enabled: true,
          transport: 'http',
          url: 'https://relay.example.test/forward',
          token: 'relay-test',
          fallbackToDirect: true,
        },
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: mainRow.id,
            accountId: mainRow.accountId,
            state: 'active',
          },
        },
      }),
      { mode: 0o600 },
    )
    let version = 1
    const gets: number[] = [],
      reports: number[] = [],
      direct: string[] = []
    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => {
        gets.push(version)
        return {
          credentialId,
          accountId: mainRow.accountId,
          material: `scoped-version-${version}`,
          recordVersion: version,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
      },
      close: () => {},
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('relay.example.test')) {
        version = 2
        if (mode === 'relay-auth-401')
          return new Response('relay secret rejected', { status: 401 })
        throw new Error('relay transport unavailable before Anthropic response')
      }
      if (!String(input).includes('/v1/messages'))
        throw new Error('unexpected upstream call')
      direct.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('rejected latest record', { status: 401 })
    }) as typeof fetch
    const plugin = await AnthropicAuthPlugin(
      { directory: root } as never,
      {
        claustrumScopedConnect: async () => scopedClient,
        scopedRosterPollIntervalMs: 0,
      } as never,
    )
    try {
      const loader = await (plugin as any).auth.loader(
        async () => ({
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
        }),
        { models: {} },
      )
      const response = await loader.fetch(MESSAGES_URL, {
        ...EMPTY_POST,
        headers: { 'x-session-affinity': 'relay-direct-rotation' },
      })
      expect(response.status).toBe(401)
      expect(direct).toEqual(['Bearer scoped-version-2'])
      expect(gets).toEqual([1, 1, 2, 2])
      expect(reports).toEqual([2])
    } finally {
      await plugin.dispose?.()
    }
  },
)

test.each([200, 401])(
  'HTTP relay retries once after scoped rotation; final upstream status %i',
  async (finalStatus) => {
    const root = await mkdtemp(
      join(tmpdir(), 'opencode-scoped-relay-rotation-'),
    )
    testDirs.push(root)
    const storagePath = join(root, 'anthropic-auth.json')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      root,
      'enrollment.json',
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await writeFile(
      process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    await writeFile(
      storagePath,
      JSON.stringify({
        version: 1,
        accounts: [],
        quota: { enabled: false },
        relay: {
          enabled: true,
          transport: 'http',
          url: 'https://relay.example.test/forward',
          token: 'relay-test',
          fallbackToDirect: true,
        },
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: mainRow.id,
            accountId: mainRow.accountId,
            state: 'active',
          },
        },
      }),
      { mode: 0o600 },
    )
    let version = 1
    const reports: number[] = [],
      relayTokens: string[] = []
    const scopedClient: ClaustrumScopedClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => ({
        credentialId,
        accountId: mainRow.accountId,
        material: `scoped-version-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
      },
      close: () => {},
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!String(input).includes('relay.example.test'))
        throw new Error('unexpected direct fetch')
      const payload = JSON.parse(String(init?.body)) as {
        upstream: { headers: Record<string, string> }
      }
      const token = payload.upstream.headers.authorization
      if (!token) throw new Error('relay omitted upstream bearer')
      relayTokens.push(token)
      if (token === 'Bearer scoped-version-1') {
        version = 2
        return new Response('old relay token rejected', {
          status: 401,
          headers: { 'request-id': 'req_upstream_rotated' },
        })
      }
      return new Response('new relay token response', {
        status: finalStatus,
        headers: { 'request-id': 'req_upstream_success' },
      })
    }) as typeof fetch
    const plugin = await AnthropicAuthPlugin(
      { directory: root } as never,
      {
        claustrumScopedConnect: async () => scopedClient,
        scopedRosterPollIntervalMs: 0,
      } as never,
    )
    try {
      const loader = await (plugin as any).auth.loader(
        async () => ({
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
        }),
        { models: {} },
      )
      const response = await loader.fetch(MESSAGES_URL, {
        ...EMPTY_POST,
        headers: { 'x-session-affinity': 'relay-rotation' },
      })
      expect(response.status).toBe(finalStatus)
      expect(await response.text()).toBe('new relay token response')
      expect(relayTokens).toEqual([
        'Bearer scoped-version-1',
        'Bearer scoped-version-2',
      ])
      expect(reports).toEqual(finalStatus === 401 ? [2] : [])
    } finally {
      await plugin.dispose?.()
    }
  },
)

test('optimistic WebSocket reports only the scoped version used by its real upstream 401', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-scoped-ws-401-'))
  testDirs.push(root)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request)
        ? undefined
        : new Response('unexpected HTTP relay', { status: 500 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ protocol: 2, type: 'ready', state: null }))
      },
      message: (socket, data) => {
        const payload = JSON.parse(String(data)) as {
          id: string
          next_hash: string
          revision: number
          upstream: { headers: Record<string, string> }
        }
        relayTokens.push(payload.upstream.headers.authorization ?? '')
        socket.send(
          JSON.stringify({
            protocol: 2,
            type: 'accepted',
            id: payload.id,
            hash: payload.next_hash,
            revision: payload.revision,
          }),
        )
        socket.send(
          JSON.stringify({
            protocol: 2,
            type: 'response_start',
            id: payload.id,
            status: 401,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
        socket.send(
          JSON.stringify({ protocol: 2, type: 'done', id: payload.id }),
        )
      },
    },
  })
  const relayTokens: string[] = []
  const storagePath = join(root, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    root,
    'enrollment.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  await writeFile(
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await writeFile(
    storagePath,
    JSON.stringify({
      version: 1,
      accounts: [],
      quota: { enabled: false },
      relay: {
        enabled: true,
        transport: 'websocket',
        url: server.url.href,
        token: 'relay-test',
        fallbackToDirect: false,
      },
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: mainRow.id,
          accountId: mainRow.accountId,
          state: 'active',
        },
      },
    }),
    { mode: 0o600 },
  )
  let gets = 0
  const reports: number[] = []
  const scopedClient: ClaustrumScopedClient = {
    listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
    getScoped: async ({ credentialId }) => {
      const version = Math.min(++gets, 2)
      return {
        credentialId,
        accountId: mainRow.accountId,
        material: `scoped-version-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3_600_000,
      }
    },
    reportAuthFailureScoped: async ({ recordVersion }) => {
      reports.push(recordVersion)
    },
    close: () => {},
  }
  globalThis.fetch = (async () => {
    throw new Error('unexpected direct send')
  }) as unknown as typeof fetch
  const plugin = await AnthropicAuthPlugin(
    { directory: root } as never,
    {
      claustrumScopedConnect: async () => scopedClient,
      scopedRosterPollIntervalMs: 0,
    } as never,
  )
  try {
    const loader = await (plugin as any).auth.loader(
      async () => ({
        type: 'oauth',
        access: '',
        refresh: 'claustrum-tombstone:v1:anthropic',
        expires: 0,
      }),
      { models: {} },
    )
    const response = await loader.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      headers: { 'x-session-affinity': `ws-scoped-401-${root}` },
    })
    expect(response.status).toBe(200) // local optimistic status, not Anthropic's 401
    await response.text().catch(() => {})
    for (let attempt = 0; attempt < 50 && reports.length === 0; attempt++)
      await Bun.sleep(10)
    expect(relayTokens).toEqual(['Bearer scoped-version-2'])
    expect(reports).toEqual([2])
  } finally {
    await plugin.dispose?.()
    await server.stop(true)
  }
})
