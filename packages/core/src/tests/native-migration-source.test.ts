import { expect, test } from 'bun:test'
import { projectNativeMigrationSource } from '../native-migration-source.ts'

const hostAuth = {
  anthropic: {
    type: 'oauth',
    access: 'synthetic-main-access',
    refresh: 'synthetic-main-refresh',
    expires: 123,
  },
}
function source(config: unknown = {}, state: unknown = {}) {
  return projectNativeMigrationSource({
    host: 'opencode',
    storageId: 'a'.repeat(64),
    configDigest: null,
    config,
    state,
    hostAuth,
  })
}

test('actual legacy main, fallback order, disable preferences and empty owned arrays survive projection', () => {
  const projected = source(
    {
      version: 1,
      mainAccountId: 'primary-route',
      fallbackOn: [],
      quota: { enabled: false },
      accounts: [
        { id: 'second', type: 'oauth', enabled: false },
        { id: 'third', type: 'api', baseURL: 'https://synthetic.invalid' },
      ],
    },
    {
      accounts: {
        second: {
          access: 'synthetic-fallback-access',
          refresh: 'synthetic-fallback-refresh',
          expires: 45,
        },
        third: { apiKey: 'synthetic-key' },
      },
    },
  )
  expect(
    projected.accounts.map((account) => [account.id, account.enabled]),
  ).toEqual([
    ['primary-route', true],
    ['second', false],
    ['third', true],
  ])
  expect(projected.accounts[1]?.credential).toMatchObject({
    refresh: 'synthetic-fallback-refresh',
  })
  expect(projected.settings).toMatchObject({
    fallbackOn: [],
    mainAccountId: 'primary-route',
    quota: { enabled: false },
  })
  expect(JSON.stringify(projected.accounts)).not.toContain(
    'synthetic-fallback-refresh',
  )
})

test('newer config credentials discard stale observations; equal-time secret disagreement refuses', () => {
  const config = {
    accounts: [
      {
        id: 'fallback',
        type: 'oauth',
        access: 'new',
        refresh: 'new-refresh',
        expires: 2,
        lastRefreshedAt: 20,
      },
    ],
  }
  const state = {
    accounts: {
      fallback: {
        access: 'old',
        refresh: 'old-refresh',
        expires: 1,
        lastRefreshedAt: 10,
        quota: { accountIdentity: 'slot' },
        lastRefreshError: { checkedAt: 5, message: 'secret' },
      },
    },
  }
  expect(source(config, state).accounts[1]?.credential).toMatchObject({
    access: 'new',
    expires: 2,
  })
  expect(source(config, state).accounts[1]?.runtime).not.toHaveProperty(
    'lastRefreshError',
  )
  expect(() =>
    source(config, {
      accounts: {
        fallback: { ...state.accounts.fallback, lastRefreshedAt: 20 },
      },
    }),
  ).toThrow('cannot be imported')
})

test('enabled identity conflicts refuse before import, disabled duplicate identity is retained', () => {
  const rows = [
    {
      id: 'one',
      type: 'oauth',
      refresh: 'one-refresh',
      anthropicAccountUuid: 'same-identity',
    },
    {
      id: 'two',
      type: 'oauth',
      refresh: 'two-refresh',
      anthropicAccountUuid: 'same-identity',
    },
  ]
  expect(() => source({ accounts: rows })).toThrow('cannot be imported')
  expect(
    source({ accounts: [{ ...rows[0], enabled: false }, rows[1]] }).accounts[1]
      ?.enabled,
  ).toBe(false)
})

test('incompatible slot-tagged quota is omitted while exact ownership and [] scope survive', () => {
  const config = {
    accounts: [
      {
        id: 'one',
        type: 'oauth',
        refresh: 'one-refresh',
        anthropicAccountUuid: 'uuid-one',
      },
    ],
  }
  expect(
    source(config, {
      accounts: { one: { quota: { accountIdentity: 'one', scoped: [] } } },
    }).accounts[1]?.quota,
  ).toBeUndefined()
  expect(
    source(config, {
      accounts: { one: { quota: { accountIdentity: 'uuid-one', scoped: [] } } },
    }).accounts[1]?.quota?.anthropic.scoped,
  ).toEqual([])
})

test('getter and proxy sources invoke no executable behavior and error contains no source', () => {
  let calls = 0
  for (const config of [
    {
      get accounts() {
        calls++
        return []
      },
    },
    new Proxy(
      {},
      {
        ownKeys() {
          calls++
          return []
        },
      },
    ),
  ])
    expect(() => source(config)).toThrow('cannot be imported')
  expect(calls).toBe(0)
})

test('settings and imported errors exclude token fields and free-form upstream messages', () => {
  const projected = source({
    relay: { enabled: true, token: 'synthetic-relay-token' },
    prime: { enabled: true, mainAuthLineageId: 'legacy' },
    refresh: {
      mainLastRefreshError: {
        checkedAt: 1,
        nextRetryAt: 2,
        message: 'synthetic-secret-in-message',
      },
    },
  })
  expect(projected.settings.relay).toEqual({ enabled: true })
  expect(projected.settings.prime).toEqual({ enabled: true })
  expect(projected.accounts[0]?.runtime.lastRefreshError).toEqual({
    checkedAt: 1,
    nextRetryAt: 2,
    message: 'Imported refresh failure',
  })
  expect(JSON.stringify(projected.accounts)).not.toContain(
    'synthetic-secret-in-message',
  )
})
