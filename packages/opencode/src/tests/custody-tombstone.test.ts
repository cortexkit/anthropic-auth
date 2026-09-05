import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotCustodyTombstone,
  buildRefreshOperationError,
  CustodyTombstoneRefreshError,
  FallbackAccountManager,
  getAccountStatePath,
  getFallbackReauthLabels,
  isCustodyTombstoneOAuth,
  isCustodyTombstoneValue,
  isPermanentRefreshError,
  isValidCustodyHandle,
  loadAccounts,
  readCustodyHandles,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'
import { extractUrl, TOKEN_URL } from './test-fetch'

const fixtureDir = join(import.meta.dir, 'fixtures', 'claustrum-golden')
const tombstoneFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'tombstone.json'), 'utf8'),
) as {
  fixtures: {
    api: { provider: string; entry: Record<string, unknown> }
    oauth: { provider: string; entry: Record<string, unknown> }
  }
}
type GoldenHandleFixture = {
  providers: Array<{
    provider: string
    shape: string
    serve: string
    accounts: Array<{
      label: string
      handle: string
      credential_id: string
      superseded?: string[]
    }>
  }>
}
const handlesFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'handles.json'), 'utf8'),
) as GoldenHandleFixture

const oauthFixture = tombstoneFixture.fixtures.oauth
const apiFixture = tombstoneFixture.fixtures.api
const originalFetch = globalThis.fetch

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: { promptAsync: mock(() => Promise.resolve()) },
  }
}

function disabledTimerOverrides() {
  return {
    setInterval: mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval,
    clearInterval: mock(() => {}) as unknown as typeof clearInterval,
  }
}

async function createTempStorage<T>(
  storage: Record<string, unknown>,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'anthropic-custody-test-'))
  const path = join(directory, 'anthropic-auth.json')
  const previous = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = path
  try {
    await saveAccounts(storage as never, path)
    return await callback(path)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = previous
    await rm(directory, { recursive: true, force: true })
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Claustrum custody tombstones', () => {
  test('recognizes only the provider-bound OAuth golden shape', () => {
    const oauth = oauthFixture.entry
    const oauthRefresh = oauth.refresh as string
    expect(isCustodyTombstoneOAuth(oauth, oauthFixture.provider)).toBe(true)
    expect(isCustodyTombstoneOAuth(oauth, apiFixture.provider)).toBe(false)
    expect(isCustodyTombstoneValue(oauthRefresh)).toBe(true)
    expect(isCustodyTombstoneOAuth(apiFixture.entry, apiFixture.provider)).toBe(
      false,
    )

    expect(
      isCustodyTombstoneOAuth(
        {
          ...oauth,
          refresh: oauthRefresh.replace(':v1:', ':v2:'),
        },
        oauthFixture.provider,
      ),
    ).toBe(false)
    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, access: `${String(oauth.access)}-different` },
        oauthFixture.provider,
      ),
    ).toBe(false)
    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, type: apiFixture.entry.type },
        oauthFixture.provider,
      ),
    ).toBe(false)
  })

  test('rejects sentinel whitespace, provider variants, and split credentials', () => {
    const oauth = oauthFixture.entry
    const oauthRefresh = oauth.refresh as string
    const anthropic2Refresh = oauthRefresh.replace(
      oauthFixture.provider,
      `${oauthFixture.provider}-2`,
    )

    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, refresh: `${oauthRefresh} ` },
        oauthFixture.provider,
      ),
    ).toBe(false)
    expect(isCustodyTombstoneOAuth(oauth, `${oauthFixture.provider}-2`)).toBe(
      false,
    )
    expect(
      isCustodyTombstoneOAuth(
        { ...oauth, refresh: anthropic2Refresh, access: anthropic2Refresh },
        oauthFixture.provider,
      ),
    ).toBe(false)

    const split = {
      ...oauth,
      access: String(oauth.access).replace(oauthRefresh, 'real-access-token'),
    }
    expect(isCustodyTombstoneOAuth(split, oauthFixture.provider)).toBe(false)
    expect(() =>
      assertNotCustodyTombstone(
        (split as Record<string, unknown>).refresh,
        oauthFixture.provider,
      ),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  test('throws a non-provider-refresh error before the token endpoint', () => {
    let thrown: unknown
    try {
      assertNotCustodyTombstone(
        oauthFixture.entry.refresh,
        oauthFixture.provider,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(thrown).toMatchObject({
      code: 'custody_tombstone_refresh',
      provider: oauthFixture.provider,
    })
    expect(thrown).not.toHaveProperty('isRefreshError')
    expect(thrown).not.toHaveProperty('permanent')
    expect(thrown).not.toHaveProperty('status')
    expect(String(thrown)).toContain(
      'vault-served main path is not yet implemented',
    )
  })

  test('preserves validated superseded handles in the parsed manifest', () => {
    const anthropicSource = handlesFixture.providers.find(
      (provider: { provider: string }) =>
        provider.provider === oauthFixture.provider,
    )
    if (!anthropicSource) throw new Error('missing anthropic fixture')
    const anthropic = readCustodyHandles(
      handlesFixture,
      oauthFixture.provider,
      anthropicSource.serve,
    )
    expect(anthropic.version).toBe(1)
    expect(anthropic.provider).toBe(anthropicSource.provider)
    expect(anthropic.serve).toBe(anthropicSource.serve)
    expect(anthropic.accounts).toEqual(
      anthropicSource.accounts.map(
        (account: {
          label: string
          handle: string
          credential_id: string
        }) => ({
          label: account.label,
          handle: account.handle,
          credentialId: account.credential_id,
        }),
      ),
    )
    const deepseekSource = handlesFixture.providers.find(
      (provider) => provider.provider === apiFixture.provider,
    )
    if (!deepseekSource) throw new Error('missing deepseek fixture')
    const deepseek = readCustodyHandles(
      handlesFixture,
      apiFixture.provider,
      deepseekSource.serve,
    )
    const deepseekBackup = deepseek.accounts[1]
    if (!deepseekBackup) throw new Error('missing deepseek backup fixture')
    if (!deepseekSource?.accounts[1]) {
      throw new Error('missing deepseek backup fixture')
    }
    expect(deepseekBackup).toMatchObject({
      handle: deepseekSource.accounts[1].handle,
    })
    expect(deepseek.superseded).toEqual(
      new Set(deepseekSource.accounts[1].superseded),
    )
  })

  test('rejects malformed handle accounts while tolerating unknown fields', () => {
    const fixture = structuredClone(handlesFixture) as {
      providers: Array<{
        provider: string
        accounts: Array<Record<string, unknown>>
      }>
    }
    const anthropic = fixture.providers.find(
      (provider) => provider.provider === oauthFixture.provider,
    )
    if (!anthropic) throw new Error('missing anthropic fixture')
    const account = anthropic.accounts[0]
    if (!account) throw new Error('missing anthropic account fixture')
    const missingHandle = { ...account }
    delete missingHandle.handle
    const missingCredentialId = { ...account }
    delete missingCredentialId.credential_id
    anthropic.accounts = [
      missingHandle,
      missingCredentialId,
      { ...account, extra: 'ignored' },
    ]

    expect(() =>
      readCustodyHandles(fixture, oauthFixture.provider, 'anthropic-auth'),
    ).toThrow('invalid account label')
  })

  test('throws when the requested provider is absent', () => {
    const fixture = structuredClone(handlesFixture)
    fixture.providers = fixture.providers.filter(
      (provider) => provider.provider !== oauthFixture.provider,
    )
    expect(() =>
      readCustodyHandles(fixture, oauthFixture.provider, 'anthropic-auth'),
    ).toThrow('missing-provider')
  })

  test('rejects prototype provider ids without polluting Object.prototype', () => {
    const malicious = JSON.parse(
      '{"providers":[{"provider":"__proto__","accounts":[]}]}',
    )
    expect(() =>
      readCustodyHandles(malicious, '__proto__', 'anthropic-auth'),
    ).toThrow()
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  test('filters invalid labels and short handles while accepting golden handles', () => {
    const fixture = structuredClone(handlesFixture) as {
      providers: Array<{
        provider: string
        accounts: Array<Record<string, unknown>>
      }>
    }
    const anthropic = fixture.providers.find(
      (provider) => provider.provider === oauthFixture.provider,
    )
    if (!anthropic) throw new Error('missing anthropic fixture')
    const account = anthropic.accounts[0]
    if (!account) throw new Error('missing anthropic account fixture')
    const invalidLabels = [
      'constructor',
      'Uppercase',
      'with space',
      'a'.repeat(65),
    ]
    anthropic.accounts = invalidLabels.map((label) => ({ ...account, label }))
    anthropic.accounts.push({
      ...account,
      handle: `ckh_${apiFixture.provider}_main`,
    })
    expect(() =>
      readCustodyHandles(fixture, oauthFixture.provider, 'anthropic-auth'),
    ).toThrow('invalid account label')

    for (const provider of handlesFixture.providers) {
      const parsed = readCustodyHandles(
        handlesFixture,
        provider.provider,
        provider.serve,
      )
      expect(parsed.accounts).toHaveLength(provider.accounts.length)
      for (const sourceAccount of provider.accounts) {
        expect(isValidCustodyHandle(sourceAccount.handle)).toBe(true)
        expect(sourceAccount.handle).toHaveLength(47)
        for (const superseded of sourceAccount.superseded ?? []) {
          expect(isValidCustodyHandle(superseded)).toBe(true)
          expect(superseded).toHaveLength(47)
        }
      }
    }

    const allHandles = handlesFixture.providers.flatMap((provider) =>
      provider.accounts.flatMap((account) => [
        account.handle,
        ...(account.superseded ?? []),
      ]),
    )
    expect(allHandles.some((handle) => /[A-Z]/.test(handle))).toBe(true)
    expect(allHandles.some((handle) => /[-_]/.test(handle))).toBe(true)
    const validHandle = allHandles[0]
    if (!validHandle) throw new Error('missing custody handle fixture')
    expect(isValidCustodyHandle(validHandle.slice(0, -1))).toBe(false)
    expect(isValidCustodyHandle(`${validHandle}A`)).toBe(false)
    expect(isValidCustodyHandle(`${validHandle.slice(0, -1)}+`)).toBe(false)
    expect(isValidCustodyHandle(`${validHandle.slice(0, -1)}/`)).toBe(false)
    expect(isValidCustodyHandle(`${validHandle.slice(0, -1)}=`)).toBe(false)
  })

  test('main loader rejects the tombstone without network or refresh state', async () => {
    const fetchCalls: string[] = []
    globalThis.fetch = mock((input: unknown) => {
      const url = extractUrl(input as string | URL | Request)
      fetchCalls.push(url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    await createTempStorage(
      {
        version: 1,
        main: { type: 'opencode', provider: oauthFixture.provider },
        refresh: { enabled: false },
        quota: { enabled: false },
        accounts: [],
      },
      async (path) => {
        const plugin = (await AnthropicAuthPlugin(
          // @ts-expect-error: minimal mock for testing
          { client: createMockClient() },
          disabledTimerOverrides(),
        )) as any
        await expect(
          plugin.auth.loader(
            () => Promise.resolve(oauthFixture.entry as never),
            { models: {} } as never,
          ),
        ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
        expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)

        const statePath = getAccountStatePath(path)
        if (existsSync(statePath)) {
          const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<
            string,
            unknown
          >
          expect(state).not.toHaveProperty('permanent')
          expect(state).not.toHaveProperty('needsReauth')
          expect(state).not.toHaveProperty('mainLastRefreshError')
          expect(state).not.toHaveProperty('backoff')
        }
        await plugin.dispose?.()
      },
    )
  })

  test('fallback refresh rejects the tombstone without network or refresh classification', async () => {
    const fetchCalls: string[] = []
    const fetchImpl = mock((input: unknown) => {
      fetchCalls.push(extractUrl(input as string | URL | Request))
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
        }),
      )
    }) as unknown as typeof fetch
    const account = {
      id: 'fallback-tombstone',
      type: 'oauth' as const,
      access: 'expired-access',
      refresh: oauthFixture.entry.refresh as string,
      expires: 0,
    }
    const storage = {
      version: 1,
      main: { type: 'opencode', provider: oauthFixture.provider },
      refresh: {
        enabled: true,
        intervalMinutes: 10,
        refreshBeforeExpiryMinutes: 30,
      },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 0, seven_day: 0 },
        failClosedOnUnknownQuota: false,
      },
      accounts: [account],
    }

    await createTempStorage(storage, async (path) => {
      const manager = new FallbackAccountManager({
        configPath: path,
        fetchImpl,
      })
      const refreshError = await manager
        .refreshAccount(account, storage as never)
        .catch((error: unknown) => error)
      expect(fetchCalls.filter((url) => url === TOKEN_URL)).toHaveLength(0)
      expect(refreshError).toBeInstanceOf(CustodyTombstoneRefreshError)
      await manager.refreshDueAccounts()
      await manager.refreshQuotaForDueAccounts()
      const loaded = await loadAccounts(path)
      expect(loaded?.accounts[0]?.type).toBe('oauth')
      if (loaded?.accounts[0]?.type === 'oauth') {
        expect(loaded.accounts[0].lastRefreshError).toBeUndefined()
        expect(loaded.accounts[0].lastQuotaRefreshError).toBeUndefined()
      }
      expect(getFallbackReauthLabels(loaded)).toEqual([])
      const classification = buildRefreshOperationError({
        error: new CustodyTombstoneRefreshError(oauthFixture.provider),
        now: 1,
        accountIdentity: account.id,
      })
      expect(isPermanentRefreshError(classification)).toBe(false)
      expect(classification.permanent).toBe(false)
    })
  })
})
