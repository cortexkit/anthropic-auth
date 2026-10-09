import { expect, test } from 'bun:test'
import { projectNativeMigrationSource } from '../native-migration-source.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'

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

const fallbackRow = {
  id: 'one',
  type: 'oauth',
  refresh: 'one-refresh',
  anthropicAccountUuid: 'uuid-one',
}
const validQuota = {
  checkedAt: 100,
  accountIdentity: 'uuid-one',
  five_hour: {
    usedPercent: 20,
    remainingPercent: 80,
    checkedAt: 100,
    resetsAt: '2030-01-01T00:00:00Z',
  },
  seven_day: { usedPercent: 5, remainingPercent: 95, checkedAt: 100 },
  scoped: [
    {
      id: 'opus',
      title: 'Opus',
      modelName: 'Claude Opus',
      usedPercent: 40,
      remainingPercent: 60,
      checkedAt: 100,
    },
  ],
  extraUsage: {
    used: { amountMinor: 100, currency: 'USD', exponent: 2 },
    limit: { amountMinor: 500, currency: 'USD', exponent: 2 },
    exhausted: false,
  },
}
const invalidQuotas: Record<string, unknown> = {
  'window without its own checkedAt': {
    checkedAt: 100,
    accountIdentity: 'uuid-one',
    five_hour: { usedPercent: 20, remainingPercent: 80 },
  },
  'scoped entry without title': {
    accountIdentity: 'uuid-one',
    scoped: [
      {
        id: 'opus',
        modelName: 'Claude Opus',
        usedPercent: 40,
        remainingPercent: 60,
        checkedAt: 100,
      },
    ],
  },
  'non-object cache value': 'not-a-quota',
  'null cache value': null,
}

test('a quota cache the native format cannot hold is omitted while the credential still imports', () => {
  for (const [name, bad] of Object.entries(invalidQuotas)) {
    const projected = source(
      { accounts: [fallbackRow] },
      { accounts: { one: { quota: bad } } },
    )
    const account = projected.accounts[1]
    expect([name, account?.id, account?.identity]).toEqual([
      name,
      'one',
      'uuid-one',
    ])
    expect([name, account?.credential]).toEqual([
      name,
      { type: 'oauth', refresh: 'one-refresh' },
    ])
    expect([name, account && Object.hasOwn(account, 'quota')]).toEqual([
      name,
      false,
    ])
  }
})

test('an unusable main quota cache is omitted while the main credential and identity import', () => {
  const fingerprint = tokenFingerprint('synthetic-main-access')
  const main = {
    profile: { providerAccountUuid: 'uuid-main' },
    profileToken: fingerprint,
    quotaToken: fingerprint,
  }
  const bad = source(
    {},
    {
      main: {
        ...main,
        quota: invalidQuotas['window without its own checkedAt'],
      },
    },
  ).accounts[0]
  expect(bad?.identity).toBe('uuid-main')
  expect(bad?.credential).toMatchObject({ refresh: 'synthetic-main-refresh' })
  expect(bad && Object.hasOwn(bad, 'quota')).toBe(false)
  const good = source(
    {},
    {
      main: {
        ...main,
        quota: { ...validQuota, accountIdentity: 'uuid-main' },
      },
    },
  ).accounts[0]
  expect(good?.quota?.anthropic.accountIdentity).toBe('uuid-main')
})

test('a valid quota owned by the verified account survives with windows, scoped entries and extra usage', () => {
  const imported = source(
    { accounts: [fallbackRow] },
    { accounts: { one: { quota: validQuota } } },
  ).accounts[1]?.quota
  expect(imported?.limits.map((limit) => limit.label)).toEqual([
    'five_hour',
    'seven_day',
    'seven_day:opus',
  ])
  expect(imported?.anthropic).toMatchObject({
    checkedAt: 100,
    accountIdentity: 'uuid-one',
    remainingPercent: { five_hour: 80, seven_day: 95 },
    scoped: [
      {
        id: 'opus',
        title: 'Opus',
        modelName: 'Claude Opus',
        remainingPercent: 60,
      },
    ],
    extraUsage: validQuota.extraUsage,
  })
})

test('a valid quota is never imported for another account or an account without a verified UUID', () => {
  expect(
    source(
      { accounts: [fallbackRow] },
      {
        accounts: {
          one: { quota: { ...validQuota, accountIdentity: 'uuid-other' } },
        },
      },
    ).accounts[1]?.quota,
  ).toBeUndefined()
  const { anthropicAccountUuid: _, ...unverified } = fallbackRow
  const account = source(
    { accounts: [unverified] },
    { accounts: { one: { quota: validQuota } } },
  ).accounts[1]
  expect(account?.credential).toMatchObject({ refresh: 'one-refresh' })
  expect(account?.quota).toBeUndefined()
  const fingerprint = tokenFingerprint('synthetic-main-access')
  expect(
    source({}, { main: { quotaToken: fingerprint, quota: validQuota } })
      .accounts[0]?.quota,
  ).toBeUndefined()
})

test('a malformed credential still refuses whether or not its quota cache is usable', () => {
  const broken = { ...fallbackRow, expires: 'not-a-number' }
  expect(() => source({ accounts: [broken] })).toThrow('cannot be imported')
  for (const quota of [validQuota, invalidQuotas['scoped entry without title']])
    expect(() =>
      source({ accounts: [broken] }, { accounts: { one: { quota } } }),
    ).toThrow('cannot be imported')
  // The same row with a well-formed credential and a valid cache imports, so
  // the refusals above come from the credential, not from the quota cache.
  expect(
    source(
      { accounts: [fallbackRow] },
      { accounts: { one: { quota: validQuota } } },
    ).accounts[1]?.credential,
  ).toMatchObject({ refresh: 'one-refresh' })
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
