import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import {
  saveAccounts,
  setAccountEnabledPersistent,
  setClaustrumModePersistent,
} from '../accounts.ts'
import {
  getClaudeCodeIdentityForVerifiedAccount,
  type ProviderAccountUuid,
} from '../claude-code.ts'
import type { ClaustrumScopedClient } from '../claustrum-scoped.ts'
import { ClaustrumScopedRuntime } from '../claustrum-scoped-runtime.ts'

const dirs: string[] = []
const runtimes: ClaustrumScopedRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close()
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'scoped-runtime-'))
  dirs.push(dir)
  const storagePath = join(dir, 'accounts.json'),
    tokenPath = join(dir, 'token.json')
  await saveAccounts({ version: 1, accounts: [] }, storagePath)
  await setClaustrumModePersistent('claustrum', storagePath)
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const gets: Array<Parameters<ClaustrumScopedClient['getScoped']>[0]> = []
  const reports: Array<
    Parameters<ClaustrumScopedClient['reportAuthFailureScoped']>[0]
  > = []
  let connects = 0,
    lists = 0,
    closes = 0
  const rows: ScopedInventoryRow[] = [
    'oauth:anthropic',
    'oauth:anthropic:work',
  ].map((id, index) => ({
    id,
    accountId: `provider-${index}`,
    categories: ['anthropic-native'],
    serves: ['anthropic'],
    providerIds: [],
    credentialType: 'oauth',
    refreshAdapter: 'anthropic',
    operations: ['read'],
    recordVersion: 1,
    createdAtMs: null,
    state: 'active',
  }))
  const client: ClaustrumScopedClient = {
    listScoped: async () => {
      lists++
      return { rows, view: 'v' }
    },
    getScoped: async (input) => {
      gets.push(input)
      return {
        credentialId: input.credentialId,
        accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
        material: 'vault-test-access',
        recordVersion: 3,
        expiresAtMs: Date.now() + 600_000,
      }
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
    },
    close: () => {
      closes++
    },
  }
  const options = {
    storagePath,
    tokenPath,
    connect: async () => {
      connects++
      return client
    },
    pollIntervalMs: 0,
  }
  const runtime = new ClaustrumScopedRuntime(options)
  runtimes.push(runtime)
  return {
    options,
    client,
    runtime,
    gets,
    reports,
    rows,
    counts: () => ({ connects, lists, closes }),
  }
}

test('metadata refresh and connection coalesce, but dispatch authorization never coalesces', async () => {
  const f = await fixture()
  await Promise.all([f.runtime.refresh(), f.runtime.refresh()])
  expect(f.counts()).toEqual({ connects: 1, lists: 1, closes: 0 })
  await Promise.all([f.runtime.authorize('main'), f.runtime.authorize('main')])
  expect(f.gets).toHaveLength(2)
})

test('a disabled route is refused even before the next metadata poll', async () => {
  const f = await fixture()
  const roster = await f.runtime.refresh()
  const id = roster?.accounts[0]?.id
  if (!id) throw new Error('missing fixture fallback')
  await f.runtime.authorize(id)
  await setAccountEnabledPersistent(id, false, f.options.storagePath)
  await expect(f.runtime.authorize(id)).rejects.toThrow('disabled')
  expect(f.gets).toHaveLength(1)
})

test('quota requests authorize freshly and report the exact served version', async () => {
  const f = await fixture()
  const sent: string[] = []
  const fetchImpl = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('', { status: 401 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(f.runtime.fetchQuota('main', fetchImpl)).rejects.toThrow('401')
  expect(sent).toEqual(['Bearer vault-test-access'])
  expect(f.gets).toHaveLength(2)
  expect(f.reports).toEqual([
    {
      credentialId: 'oauth:anthropic',
      enrollmentToken: '01'.repeat(32),
      providerStatus: 401,
      recordVersion: 3,
      reporterSource: 'direct',
    },
  ])
})

test('a late connector is closed rather than resurrected after shutdown', async () => {
  const f = await fixture()
  const started = deferred<void>(),
    connection = deferred<ClaustrumScopedClient>()
  const runtime = new ClaustrumScopedRuntime({
    ...f.options,
    connect: () => {
      started.resolve()
      return connection.promise
    },
  })
  runtimes.push(runtime)
  const result = runtime.refresh().then(
    () => 'resolved',
    () => 'rejected',
  )
  await started.promise
  runtime.close()
  connection.resolve(f.client)
  expect(await result).toBe('rejected')
  expect(f.counts().closes).toBe(1)
  expect(runtime.snapshot()).toBeUndefined()
})

test('local mode performs no vault connection and rejects any stale scoped dispatch', async () => {
  const f = await fixture()
  await setClaustrumModePersistent('local', f.options.storagePath)
  expect(await f.runtime.refresh()).toBeUndefined()
  await expect(f.runtime.authorize('main')).rejects.toThrow('not active')
  expect(f.counts().connects).toBe(0)
})

test('custodian-verified metadata keeps device identity stable without token input', () => {
  const first = getClaudeCodeIdentityForVerifiedAccount(
    'verified-test-slot',
    'provider-a' as ProviderAccountUuid,
  )
  const second = getClaudeCodeIdentityForVerifiedAccount(
    'verified-test-slot',
    'provider-a' as ProviderAccountUuid,
  )
  expect(first.deviceId).toBe(second.deviceId)
  expect(String(second.accountUuid)).toBe('provider-a')
  const replacement = getClaudeCodeIdentityForVerifiedAccount(
    'verified-test-slot',
    'provider-b' as ProviderAccountUuid,
  )
  expect(replacement.deviceId).toBe(first.deviceId)
  expect(String(replacement.accountUuid)).toBe('provider-b')
})

test('a peer replacing primary cannot leave an old still-valid alias authorized as main', async () => {
  const f = await fixture()
  const original = f.rows[0]
  if (!original) throw new Error('Missing primary fixture')
  f.rows[0] = { ...original, state: 'needs_reauth' }
  f.rows.push({ ...original, id: 'oauth:anthropic:old-alias', state: 'active' })
  await f.runtime.refresh()
  expect(f.runtime.snapshot()?.primary?.credentialId).toBe(
    'oauth:anthropic:old-alias',
  )
  f.rows[0] = {
    ...original,
    state: 'active',
    accountId: 'replacement-provider',
  }
  const peer = new ClaustrumScopedRuntime(f.options)
  runtimes.push(peer)
  await peer.refresh()
  await expect(f.runtime.authorize('main')).rejects.toThrow('changed')
  expect(f.gets).toHaveLength(0)
})

test('profile hydration uses a new scoped receipt and binds metadata to its provider identity', async () => {
  const f = await fixture()
  const headers: string[] = []
  const http = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      expect(String(input)).toBe('https://api.anthropic.com/api/oauth/profile')
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      return Response.json({
        organization: {
          rate_limit_tier: 'default_claude_max_5x',
          organization_type: 'individual',
        },
      })
    },
    { preconnect: fetch.preconnect },
  )
  const first = await f.runtime.fetchProfile('main', http)
  const second = await f.runtime.fetchProfile('main', http)
  expect(first.accountIdentity).toBe(f.rows[0]?.accountId)
  expect(String(first.providerAccountUuid)).toBe(String(f.rows[0]?.accountId))
  expect(second.tier).toBe('default_claude_max_5x')
  expect(f.gets).toHaveLength(2)
  expect(headers).toEqual([
    'Bearer vault-test-access',
    'Bearer vault-test-access',
  ])
  expect(f.reports).toHaveLength(0)
})

test('profile 401 retries the new record and reports its version if it also fails', async () => {
  const f = await fixture()
  const sent: string[] = []
  const http = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      f.client.getScoped = async (input) => ({
        credentialId: input.credentialId,
        accountId: f.rows[0]?.accountId,
        material: 'new-vault-access',
        recordVersion: 4,
        expiresAtMs: Date.now() + 600_000,
      })
      return new Response(null, { status: 401 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(f.runtime.fetchProfile('main', http)).rejects.toThrow('401')
  expect(f.reports).toHaveLength(1)
  expect(sent).toEqual(['Bearer vault-test-access', 'Bearer new-vault-access'])
  expect(f.reports[0]?.recordVersion).toBe(4)
})

test('cancelling a dispatch during connection setup does not wait for or cancel shared discovery', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const connection = deferred<ClaustrumScopedClient>()
  const runtime = new ClaustrumScopedRuntime({
    ...f.options,
    connect: () => {
      entered.resolve()
      return connection.promise
    },
  })
  runtimes.push(runtime)
  const controller = new AbortController()
  const request = runtime.authorize('main', controller.signal)
  const outcome = request.then(
    () => 'unexpected success',
    (error: unknown) => String(error),
  )
  try {
    await entered.promise
    const shared = runtime.refresh()
    controller.abort(new Error('caller cancelled'))
    expect(await outcome).toContain('caller cancelled')
    expect(f.gets).toHaveLength(0)
    connection.resolve(f.client)
    expect((await shared)?.primary?.accountId).toBe(f.rows[0]?.accountId)
    expect((await runtime.authorize('main')).accountId).toBe(
      String(f.rows[0]?.accountId),
    )
  } finally {
    connection.resolve(f.client)
  }
})

test('shutdown rejects connection waiters immediately and closes a late client', async () => {
  const f = await fixture()
  const entered = deferred<void>()
  const closed = deferred<void>()
  const connection = deferred<ClaustrumScopedClient>()
  const runtime = new ClaustrumScopedRuntime({
    ...f.options,
    connect: () => {
      entered.resolve()
      return connection.promise
    },
  })
  runtimes.push(runtime)
  const outcome = runtime.refresh().then(
    () => 'unexpected success',
    (error: unknown) => String(error),
  )
  const client = {
    ...f.client,
    close: () => {
      f.client.close()
      closed.resolve()
    },
  }
  try {
    await entered.promise
    runtime.close()
    expect(await outcome).toContain('closed')
    connection.resolve(client)
    await closed.promise
    expect(f.counts().closes).toBe(1)
    expect(f.counts().lists).toBe(0)
  } finally {
    connection.resolve(client)
  }
})

test('onRoster fires only when the discovery view changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scoped-runtime-view-'))
  dirs.push(dir)
  const storagePath = join(dir, 'accounts.json'),
    tokenPath = join(dir, 'token.json')
  await saveAccounts({ version: 1, accounts: [] }, storagePath)
  await setClaustrumModePersistent('claustrum', storagePath)
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '02'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  let view = 'v1'
  const seen: string[] = []
  const runtime = new ClaustrumScopedRuntime({
    storagePath,
    tokenPath,
    connect: async () => ({
      listScoped: async () => ({
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: 'provider-0',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            providerIds: [],
            credentialType: 'oauth',
            refreshAdapter: 'anthropic',
            operations: ['read'],
            recordVersion: 1,
            createdAtMs: null,
            state: 'active',
          },
        ],
        view,
      }),
      getScoped: async () => {
        throw new Error('no dispatch in this test')
      },
      reportAuthFailureScoped: async () => {},
      close: () => {},
    }),
    pollIntervalMs: 0,
    onRoster: (roster) => {
      seen.push(roster.view)
    },
  })
  runtimes.push(runtime)
  await runtime.refresh()
  await runtime.refresh()
  // Second poll with an identical view must not re-notify: subscribers
  // refresh quotas and rewrite shared state files on every notification.
  expect(seen).toEqual(['v1'])
  view = 'v2'
  await runtime.refresh()
  expect(seen).toEqual(['v1', 'v2'])
})

test('two project runtimes sharing storage serve the persisted roster while a peer holds discovery lease', async () => {
  const f = await fixture()
  const original = await f.runtime.refresh()
  expect(original?.primary?.credentialId).toBe('oauth:anthropic')
  const entered = deferred<void>()
  const release = deferred<void>()
  let peerLists = 0
  const peer = new ClaustrumScopedRuntime({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => {
        peerLists++
        entered.resolve()
        await release.promise
        return { rows: f.rows, view: 'new-view' }
      },
    }),
  })
  runtimes.push(peer)
  const held = peer.refresh()
  await entered.promise
  const another = new ClaustrumScopedRuntime(f.options)
  runtimes.push(another)
  try {
    const alreadyCommitted = await another.refresh()
    expect(alreadyCommitted?.view).toBe(original?.view)
    expect(alreadyCommitted?.primary?.accountId).toBe('provider-0')
    expect(alreadyCommitted?.accounts[0]?.claustrumScopedCredentialId).toBe(
      'oauth:anthropic:work',
    )
    expect(peerLists).toBe(1)
    const receipt = await another.authorize('main')
    expect(receipt.accountId).toBe('provider-0')
    expect(f.gets.at(-1)?.credentialId).toBe('oauth:anthropic')
  } finally {
    release.resolve()
    await held
  }
})

test.each(['quota', 'profile'] as const)(
  '%s recovers a 401 only when the same scoped account advances',
  async (kind) => {
    const f = await fixture()
    let version = 3
    const sent: string[] = []
    f.client.getScoped = async (input) => {
      f.gets.push(input)
      return {
        credentialId: input.credentialId,
        accountId: f.rows[0]?.accountId,
        material: `vault-v${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 600_000,
      }
    }
    const http = Object.assign(
      async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        sent.push(authorization)
        if (authorization === 'Bearer vault-v3') {
          version = 4
          return new Response(null, { status: 401 })
        }
        return kind === 'quota'
          ? Response.json({ five_hour: { utilization: 10 } })
          : Response.json({
              organization: {
                rate_limit_tier: 'default_claude_max_5x',
                organization_type: 'individual',
              },
            })
      },
      { preconnect: fetch.preconnect },
    )
    const result =
      kind === 'quota'
        ? await f.runtime.fetchQuota('main', http)
        : await f.runtime.fetchProfile('main', http)
    expect(result).toBeDefined()
    expect(sent).toEqual(['Bearer vault-v3', 'Bearer vault-v4'])
    expect(f.gets).toHaveLength(2)
    expect(f.reports).toEqual([])
  },
)
