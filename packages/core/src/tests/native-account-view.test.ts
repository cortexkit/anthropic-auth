import { expect, test } from 'bun:test'
import { fingerprintOf, type PoolRow } from '@cortexkit/common-auth/store'
import {
  applyNativeMetadataPatch,
  nativeAccountReadError,
  nativeQuotaFailure,
  projectNativeAccountViews,
} from '../native-account-view.ts'
import type { NativeRuntimeState } from '../native-runtime.ts'
import type { NativePoolPaths } from '../pool-paths.ts'

const paths: NativePoolPaths = {
  storageId: 'a'.repeat(64),
  config: '/synthetic/config',
  state: '/synthetic/state',
  runtime: '/synthetic/runtime',
  roster: '/synthetic/roster',
  journal: '/synthetic/journal',
  legacyConfig: '/synthetic/legacy',
  legacyState: '/synthetic/legacy-state',
}
const uuid = '11111111-2222-4333-8444-555555555555'
const row: PoolRow = {
  id: 'primary-row',
  type: 'oauth',
  enabled: true,
  identity: uuid,
  credentialEpoch: 2,
  hasEntry: true,
  candidate: true,
  needsFirstReading: false,
  stamp: 'bound',
  credential: {
    type: 'oauth',
    access: 'synthetic-secret-access',
    refresh: 'synthetic-secret-refresh',
    expires: 1000,
  },
}
const runtime: NativeRuntimeState = {
  version: 1,
  storageId: paths.storageId,
  accounts: {
    'primary-row': {
      binding: {
        kind: 'local',
        storageId: paths.storageId,
        rowId: row.id,
        credentialEpoch: 1,
        identity: uuid,
      },
      lastUsed: 100,
      prime: { count: 7, inputTokens: 8, outputTokens: 9, since: 1 },
    },
  },
}

test('secret-free native policy projection preserves primary and fallback order without inheriting stale metadata', () => {
  const snapshot = projectNativeAccountViews({
    paths,
    rows: [
      row,
      { ...row, id: 'fallback-b', enabled: false },
      { ...row, id: 'fallback-a' },
    ],
    settings: {
      mainAccountId: row.id,
      relay: { enabled: true, token: 'synthetic-relay-secret' },
      refresh: { enabled: true, mainRefreshLeaseTokenHash: 'secret-old-state' },
      prime: { enabled: true, main: { count: 99 } },
      access: 'synthetic-secret-access',
    },
    runtime,
  })
  expect(snapshot.accounts.map((row) => row.id)).toEqual([
    'main',
    'fallback-b',
    'fallback-a',
  ])
  expect(snapshot.accounts[1]?.enabled).toBe(false)
  expect(snapshot.accounts[0]?.prime).toBeUndefined()
  expect(snapshot.policyStorage.accounts.map((row) => row.id)).toEqual([
    'fallback-b',
    'fallback-a',
  ])
  expect(JSON.stringify(snapshot)).not.toContain('synthetic-secret')
  expect(JSON.stringify(snapshot)).not.toContain('synthetic-relay-secret')
  expect(snapshot.settings.refresh).toEqual({ enabled: true })
  expect(snapshot.settings.prime).toEqual({ enabled: true })
  expect(snapshot.policyStorage.prime?.main).toBeUndefined()
})

test('vault primary alias maps to main while runtime scopes and windowless freshness survive', () => {
  const state: NativeRuntimeState = {
    version: 1,
    storageId: paths.storageId,
    accounts: {
      'seeded-primary': {
        binding: {
          kind: 'custody',
          storageId: paths.storageId,
          routeId: 'seeded-primary',
          credentialId: 'oauth:alias',
          accountIdentity: uuid,
          recordVersion: 7,
        },
        quota: {
          limits: [],
          anthropic: {
            version: 1,
            remainingPercent: {},
            scoped: [],
            accountIdentity: uuid,
            source: 'poll',
            checkedAt: 900,
          },
        },
        prime: { count: 3, inputTokens: 4, outputTokens: 5, since: 1 },
      },
    },
  }
  const snapshot = projectNativeAccountViews({
    paths,
    rows: [],
    settings: {
      mainAccountId: 'seeded-primary',
      claustrum: {
        mode: 'claustrum',
        primaryAccount: {
          credentialId: 'oauth:anthropic',
          accountId: uuid,
          state: 'active',
        },
      },
    },
    runtime: state,
    roster: {
      version: 1,
      complete: true,
      rows: [
        {
          routeId: 'seeded-primary',
          credentialId: 'oauth:alias',
          aliases: ['oauth:anthropic'],
          credentialType: 'oauth',
          accountIdentity: uuid,
          state: 'active',
          enabled: true,
          label: 'main',
          addedAt: 0,
        },
      ],
      declined: [],
    },
  })
  expect(snapshot.accounts[0]?.id).toBe('main')
  expect(snapshot.accounts[0]?.quota?.scoped).toEqual([])
  expect(snapshot.policyStorage.quota?.mainQuotaCheckedAt).toBe(900)
  expect(snapshot.policyStorage.prime?.main?.count).toBe(3)
})

test('safe quota error classification excludes 401 and 403 and keeps healthy 429 retry policy', () => {
  for (const status of [401, 403]) {
    const safe = nativeAccountReadError(
      Object.assign(new Error('synthetic-sensitive-body'), { status }),
    )
    expect(safe.status).toBe(status)
    expect(safe.message).not.toContain('synthetic-sensitive-body')
    expect(nativeQuotaFailure(safe, uuid, 100)).toBeUndefined()
  }
  expect(
    nativeQuotaFailure(
      Object.assign(new Error('limited'), { status: 429 }),
      uuid,
      100,
    )?.nextRetryAt,
  ).toBe(60_100)
})

test('native lastUsed publication is monotonic for older asynchronous observations', () => {
  const entry = runtime.accounts['primary-row']
  if (!entry) throw new Error('Missing fixture entry')
  expect(
    applyNativeMetadataPatch({ ...entry, lastUsed: 200 }, { lastUsed: 100 })
      .lastUsed,
  ).toBe(200)
})

for (const lineage of ['current', 'previous', 'unbound'] as const) {
  test(`local account projection keeps only current or unbound refresh errors (${lineage})`, () => {
    if (!row.credential) throw new Error('Expected an OAuth fixture')
    const credentialEpoch = row.credentialEpoch
    if (credentialEpoch === undefined)
      throw new Error('Expected a bound fixture')
    const currentFingerprint = fingerprintOf(row.credential)
    const state: NativeRuntimeState = {
      version: 1,
      storageId: paths.storageId,
      accounts: {
        [row.id]: {
          binding: {
            kind: 'local',
            storageId: paths.storageId,
            rowId: row.id,
            credentialEpoch,
            identity: uuid,
          },
          lastRefreshError: {
            message: 'Synthetic refresh rejection',
            checkedAt: 200,
            nextRetryAt: 10000,
            retryCount: 1,
            accountIdentity: uuid,
            permanent: true,
            ...(lineage === 'unbound'
              ? {}
              : {
                  credentialFingerprint:
                    lineage === 'current' ? currentFingerprint : 'b'.repeat(64),
                }),
          },
          lastUsed: 100,
        },
      },
    }
    const snapshot = projectNativeAccountViews({
      paths,
      rows: [row],
      settings: { mainAccountId: row.id },
      runtime: state,
    })
    expect(snapshot.accounts[0]?.lastUsed).toBe(100)
    if (lineage === 'previous')
      expect(snapshot.accounts[0]?.lastRefreshError).toBeUndefined()
    else expect(snapshot.accounts[0]?.lastRefreshError?.permanent).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain(currentFingerprint)
  })
}
