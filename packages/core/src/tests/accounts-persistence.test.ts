import { afterEach, expect, test } from 'bun:test'
import { strictEqual } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  createEmptyStorage,
  FallbackAccountManager,
  getRefreshBeforeExpiryMs,
  hasNoLocalCredential,
  loadAccounts,
  type OAuthAccount,
  saveAccountState,
  saveAccounts,
} from '../accounts.ts'
import { custodyTombstoneOAuth } from '../claustrum.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('recognizes an OAuth account with no local credential', () => {
  expect(hasNoLocalCredential({})).toBe(true)
  expect(hasNoLocalCredential({ refresh: '' })).toBe(true)
  expect(hasNoLocalCredential({ refresh: 'refresh' })).toBe(false)
  expect(hasNoLocalCredential({ access: '' })).toBe(false)
})

test('keeps the vault-facing refresh TTL at 270 minutes', () => {
  const vaultMinTtlMs =
    getRefreshBeforeExpiryMs(createEmptyStorage()) + 30 * 60_000
  const expectedVaultMinTtlMs = 270 * 60_000
  // Anthropic OAuth access tokens live 8h; the vault refreshes a credential when
  // `now + minTtl >= expires_at`, so this value alone fixes the observed rotation
  // period. State the resulting PERIOD, not just the minTtl: the period is the
  // number the vault operator needs to pre-seed their stall detector.
  const tokenLifetimeMinutes = 480
  const newPeriodMinutes = tokenLifetimeMinutes - vaultMinTtlMs / 60_000
  const oldPeriodMinutes = tokenLifetimeMinutes - expectedVaultMinTtlMs / 60_000
  const guidance = [
    'Vault coupling tripwire: this derived value is passed as minTtl to Claustrum',
    '`credential.get`, and the vault refreshes when `now + minTtl >= expires_at`.',
    `It therefore sets the observed rotation period to token_lifetime - minTtl =`,
    `${tokenLifetimeMinutes} - ${vaultMinTtlMs / 60_000} = ${newPeriodMinutes} minutes`,
    `(was ${oldPeriodMinutes} minutes at the expected ${expectedVaultMinTtlMs / 60_000}).`,
    newPeriodMinutes > oldPeriodMinutes
      ? 'THIS CHANGE LENGTHENS THE PERIOD, WHICH REQUIRES ADVANCE NOTICE: the vault operator alarms on MAX(recent gaps) + 30m, so the first longer gap trips a false stall alarm that REPEATS on a 30-minute cooldown until the refresh lands. Tell them the new period above before deploying so they can pre-seed it.'
      : 'This change shortens the period, which is silent for the vault operator and needs no notice.',
  ].join(' ')

  strictEqual(vaultMinTtlMs, expectedVaultMinTtlMs, guidance)
})

test('preserves the Claustrum mode when a save supplies only handlesFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storage = createEmptyStorage()

  await saveAccounts({ ...storage, claustrum: { mode: 'claustrum' } }, path)
  await saveAccounts({ ...storage, claustrum: { handlesFile: '/x' } }, path)

  await expect(loadAccounts(path)).resolves.toMatchObject({
    claustrum: { mode: 'claustrum', handlesFile: '/x' },
  })
})

test('saveAccounts cannot persist a Claustrum mode change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storage = createEmptyStorage()

  await saveAccounts({ ...storage, claustrum: { mode: 'claustrum' } }, path)
  await saveAccounts({ ...storage, claustrum: { mode: 'local' } }, path)

  await expect(loadAccounts(path)).resolves.toMatchObject({
    claustrum: { mode: 'claustrum' },
  })
})

test('drops a persisted non-string Claustrum handlesFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accounts: [],
      claustrum: { handlesFile: 42 },
    }),
  )

  await expect(loadAccounts(path)).resolves.not.toMatchObject({
    claustrum: expect.anything(),
  })
})

test('drops a persisted blank Claustrum handlesFile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')

  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accounts: [],
      claustrum: { handlesFile: '   ' },
    }),
  )

  await expect(loadAccounts(path)).resolves.not.toMatchObject({
    claustrum: expect.anything(),
  })
})

test('excludes an empty-material vault fallback after its quota policy fails', async () => {
  const now = 1_000_000
  const account: OAuthAccount = {
    id: 'vault-fallback',
    type: 'oauth',
    enabled: true,
    quota: {
      checkedAt: 0,
      five_hour: { usedPercent: 96, remainingPercent: 4, checkedAt: 0 },
      seven_day: { usedPercent: 96, remainingPercent: 4, checkedAt: 0 },
    },
  }
  const storage: AccountStorage = {
    version: 1,
    claustrum: { mode: 'claustrum' },
    quota: {
      enabled: true,
      minimumRemaining: { five_hour: 10, seven_day: 10 },
      failClosedOnUnknownQuota: true,
    },
    accounts: [account],
  }
  const authorizations: string[] = []
  const manager = new FallbackAccountManager({
    now: () => now,
    isFallbackAccountVaultEnabled: () => true,
    isFallbackAccountVaultServed: () => true,
    resolveFallbackAccessToken: () => ({
      token: 'vault-fallback-access',
      source: 'vault',
    }),
    fetchImpl: async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 96 },
          seven_day: { utilization: 96 },
        }),
      )
    },
  })

  await expect(manager.getUsableFallbackAccounts(storage)).resolves.toEqual([])
  expect(authorizations).toEqual(['Bearer vault-fallback-access'])
})

test('keeps a live vault fallback on cached quota after a transient quota failure', async () => {
  const now = 1_000_000
  const account: OAuthAccount = {
    id: 'vault-fallback',
    enabled: true,
    ...custodyTombstoneOAuth('anthropic'),
    quota: {
      checkedAt: now - 60_000,
      five_hour: {
        usedPercent: 10,
        remainingPercent: 90,
        checkedAt: now - 60_000,
      },
      seven_day: {
        usedPercent: 10,
        remainingPercent: 90,
        checkedAt: now - 60_000,
      },
    },
  }
  const storage: AccountStorage = {
    version: 1,
    claustrum: { mode: 'claustrum' },
    quota: {
      enabled: true,
      checkIntervalMinutes: 1,
      minimumRemaining: { five_hour: 10, seven_day: 10 },
      failClosedOnUnknownQuota: true,
    },
    accounts: [account],
  }
  const manager = new FallbackAccountManager({
    now: () => now,
    isFallbackAccountVaultEnabled: () => true,
    isFallbackAccountVaultServed: () => true,
    resolveFallbackAccessToken: () => ({
      token: 'vault-fallback-access',
      source: 'vault',
    }),
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  })

  await expect(manager.getUsableFallbackAccounts(storage)).resolves.toEqual([
    account,
  ])
})

test('keeps tombstone metadata when discarding a stale credential write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  const storedQuota = {
    checkedAt: 200,
    five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: 200 },
    seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt: 200 },
  }
  await saveAccounts(
    {
      version: 1,
      accounts: [
        {
          id: 'work',
          type: 'oauth',
          access: '',
          refresh: 'claustrum-tombstone:v1:anthropic',
          expires: 0,
          quota: storedQuota,
        },
      ],
    },
    path,
  )

  await saveAccounts(
    {
      version: 1,
      accounts: [
        {
          id: 'work',
          type: 'oauth',
          access: 'stale-access',
          refresh: 'stale-refresh',
          expires: 100,
          quota: {
            checkedAt: 100,
            five_hour: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 100,
            },
            seven_day: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 100,
            },
          },
        },
      ],
    },
    path,
  )

  await expect(loadAccounts(path)).resolves.toMatchObject({
    accounts: [
      {
        id: 'work',
        access: '',
        refresh: 'claustrum-tombstone:v1:anthropic',
        quota: storedQuota,
      },
    ],
  })
})

test('main quota persistence ignores an unbound future observation timestamp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'accounts-persistence-'))
  directories.push(directory)
  const path = join(directory, 'anthropic-auth.json')
  await saveAccounts(
    {
      version: 1,
      accounts: [],
      mainAccountId: 'account-a',
      quota: {
        mainQuota: {
          accountIdentity: 'account-a',
          checkedAt: 200,
          five_hour: {
            usedPercent: 20,
            remainingPercent: 80,
            checkedAt: 200,
          },
        },
        mainQuotaCheckedAt: 200,
        mainQuotaToken: 'lineage-a',
      },
    },
    path,
  )

  const stale = await loadAccounts(path)
  if (!stale?.quota) throw new Error('missing quota fixture')
  stale.quota.mainQuota = {
    accountIdentity: 'account-a',
    checkedAt: 100,
    five_hour: {
      usedPercent: 80,
      remainingPercent: 20,
      checkedAt: 100,
    },
  }
  stale.quota.mainQuotaCheckedAt = 999
  await saveAccountState(stale, path, { mainQuota: true })

  await expect(loadAccounts(path)).resolves.toMatchObject({
    quota: {
      mainQuota: {
        checkedAt: 200,
        five_hour: { usedPercent: 20 },
      },
      mainQuotaCheckedAt: 200,
    },
  })
})
