import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountStorage } from '../../../core/src/accounts.ts'
import {
  configuredAnthropicOAuthAccountCount,
  QUOTA_HEADER_FEED_LEASE_MS,
  QUOTA_HEADER_FEED_SCHEMA_VERSION,
  type QuotaHeaderFeedEntry,
  QuotaHeaderFeedRegistry,
} from '../../../core/src/quota-header-feed.ts'

const quota = { bindingWindow: 'five_hour', fallbackAdvised: false }

function entry(overrides: Record<string, unknown> = {}): QuotaHeaderFeedEntry {
  return {
    identity_source: 'credential_id',
    credential_id: 'cred-1',
    schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
    provider: 'anthropic',
    configured_account_count: 1,
    observed_at_ms: 1_000,
    quota,
    ...overrides,
  } as QuotaHeaderFeedEntry
}

function storage(accounts: AccountStorage['accounts']): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts,
  }
}

function noneEntry(): QuotaHeaderFeedEntry {
  const { credential_id: _credentialId, ...withoutCredential } =
    entry() as Extract<
      QuotaHeaderFeedEntry,
      { identity_source: 'credential_id' }
    >
  return { ...withoutCredential, identity_source: 'none' }
}

describe('quota header feed', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quota-header-feed-test-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('requires schema version and provider', async () => {
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'required',
    })
    await expect(
      registry.publish({ ...entry(), accountKey: 'a' }),
    ).resolves.toBeUndefined()
    const raw = JSON.parse(
      await readFile(join(directory, 'required.json'), 'utf8'),
    )
    expect(raw.entries.a.schema_version).toBe(1)
    expect(raw.entries.a.provider).toBe('anthropic')
  })

  test('rejects unknown schema versions', async () => {
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'unknown.json'),
      JSON.stringify({
        version: 999,
        entries: { a: { ...entry(), schema_version: 999 } },
        updated_at_ms: 1_000,
      }),
    )
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      now: () => 1_000,
    })
    expect(await registry.list()).toEqual([])
  })

  test('enforces identity exclusivity and omits identity fields for none', async () => {
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'identity',
    })
    await expect(
      registry.publish({ ...entry({ account_ref: 'ref-1' }), accountKey: 'a' }),
    ).rejects.toThrow()
    await expect(
      registry.publish({
        ...noneEntry(),
        accountKey: 'none',
      }),
    ).resolves.toBeUndefined()
    const raw = JSON.parse(
      await readFile(join(directory, 'identity.json'), 'utf8'),
    )
    expect(raw.entries.none).not.toHaveProperty('credential_id')
    expect(raw.entries.none).not.toHaveProperty('account_ref')
  })

  test.each(['main', '', null])(
    'rejects sentinel identity value %p',
    async (value) => {
      const registry = new QuotaHeaderFeedRegistry({ directory })
      await expect(
        registry.publish({
          ...entry({ credential_id: value as string | null }),
          accountKey: 'a',
        }),
      ).rejects.toThrow()
    },
  )

  test('counts live main OAuth and every OAuth fallback, including disabled and migrated', () => {
    const accounts = [
      { id: 'idle', type: 'oauth', refresh: 'r' },
      { id: 'disabled', type: 'oauth', refresh: 'r', enabled: false },
      { id: 'migrated', type: 'oauth', refresh: 'r', enabled: true },
      { id: 'api', type: 'api', apiKey: 'k', baseURL: 'https://example.com' },
    ] as AccountStorage['accounts']
    expect(
      configuredAnthropicOAuthAccountCount({
        storage: storage(accounts),
        mainOAuthConfigured: true,
      }),
    ).toBe(4)
    expect(
      configuredAnthropicOAuthAccountCount({
        storage: storage(accounts),
        mainOAuthConfigured: false,
      }),
    ).toBe(3)
  })

  test('absent main identity uses none', async () => {
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'none',
      now: () => 1_001,
    })
    await registry.publish({
      ...noneEntry(),
      accountKey: 'a',
    })
    expect((await registry.list())[0]).toEqual(
      expect.objectContaining({ identity_source: 'none' }),
    )
  })

  test('uses restrictive permissions and atomic temp rename', async () => {
    await chmod(directory, 0o777)
    expect((await stat(directory)).mode & 0o777).toBe(0o777)
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'permissions',
    })
    await registry.publish({ ...entry(), accountKey: 'a' })
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, 'permissions.json'))).mode & 0o777).toBe(
      0o600,
    )
    expect(await readdir(directory)).toEqual(['permissions.json'])
  })

  test('publishes only the allowlisted quota fields', async () => {
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'quota-fields',
    })
    await registry.publish({
      ...entry({
        quota: {
          five_hour: undefined,
          seven_day: undefined,
          bindingWindow: 'five_hour',
          fallbackAdvised: false,
          unexpected_secret: 'must-not-publish',
        } as unknown as QuotaHeaderFeedEntry['quota'],
      }),
      accountKey: 'a',
    })
    const raw = JSON.parse(
      await readFile(join(directory, 'quota-fields.json'), 'utf8'),
    )
    const bytes = await readFile(join(directory, 'quota-fields.json'), 'utf8')
    expect(raw.entries.a.quota).toEqual({
      bindingWindow: 'five_hour',
      fallbackAdvised: false,
    })
    expect(raw.entries.a.quota).not.toHaveProperty('unexpected_secret')
    expect(bytes).not.toContain('must-not-publish')
    expect(bytes).not.toContain('authorization')
    expect(bytes).not.toContain('access-token')
  })

  test('ignores stale, future, and malformed records', async () => {
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'stale.json'),
      JSON.stringify({
        version: 1,
        entries: { a: entry({ observed_at_ms: 1_000 }) },
      }),
    )
    await writeFile(
      join(directory, 'future.json'),
      JSON.stringify({
        version: 1,
        entries: { a: entry({ observed_at_ms: 181_001 }) },
      }),
    )
    await writeFile(join(directory, 'bad.json'), '{not-json')
    const registry = new QuotaHeaderFeedRegistry({
      directory,
      now: () => 1_000 + QUOTA_HEADER_FEED_LEASE_MS,
    })
    expect(await registry.list()).toEqual([])
  })

  test('deduplicates one account using newest observation', async () => {
    const first = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'first',
      now: () => 1_003,
    })
    const second = new QuotaHeaderFeedRegistry({
      directory,
      instanceId: 'second',
      now: () => 1_003,
    })
    await first.publish({
      ...entry({ observed_at_ms: 1_001 }),
      accountKey: 'same',
    })
    await second.publish({
      ...entry({ observed_at_ms: 1_002, credential_id: 'new' }),
      accountKey: 'same',
    })
    expect(await first.list()).toEqual([
      entry({ observed_at_ms: 1_002, credential_id: 'new' }),
    ])
  })
})
