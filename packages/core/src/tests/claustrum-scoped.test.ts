import { describe, expect, test } from 'bun:test'
import {
  ClaustrumClient,
  type ClaustrumConnector,
  type ScopedInventoryRow,
} from '@cortexkit/claustrum-client'
import {
  type ClaustrumScopedClient,
  ClaustrumScopedCustody,
  decideScopedRetryAfter401,
  isScopedCredentialRotation,
} from '../claustrum-scoped.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'

async function captureLogs<T>(
  run: () => Promise<T> | T,
): Promise<{ result: T; records: LogTestRecord[] }> {
  const records: LogTestRecord[] = []
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  try {
    return { result: await run(), records }
  } finally {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  }
}

const identity = {
  credentialId: 'oauth:anthropic:work',
  accountId: 'account-1',
}
const row: ScopedInventoryRow = {
  id: identity.credentialId,
  accountId: identity.accountId,
  categories: ['anthropic-native'],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  operations: ['read'],
  state: 'active',
  recordVersion: 1,
  createdAtMs: null,
}
function fixture(overrides: Partial<ClaustrumScopedClient> = {}) {
  const gets: unknown[] = []
  const reports: unknown[] = []
  let token = '01'.repeat(32)
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({ rows: [row], view: 'view-1' }),
    getScoped: async (input) => {
      gets.push(input)
      return {
        credentialId: identity.credentialId,
        accountId: identity.accountId,
        material: 'test-access',
        recordVersion: 7,
        expiresAtMs: 1_000_000,
      }
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
    },
    close: () => {},
    ...overrides,
  }
  const custody = new ClaustrumScopedCustody({
    client,
    readToken: async () => ({ token, token_generation: 1 }),
    now: () => 1_000,
  })
  return {
    custody,
    gets,
    reports,
    rotate: () => {
      token = '02'.repeat(32)
    },
  }
}

describe('scoped custody dispatch authorization', () => {
  test('authorizes every dispatch and rereads the consumer token', async () => {
    const f = fixture()
    await f.custody.authorize(identity)
    f.rotate()
    await f.custody.authorize(identity)
    expect(f.gets).toEqual([
      {
        ...{ credentialId: identity.credentialId },
        enrollmentToken: '01'.repeat(32),
        minTtlMs: 300_000,
      },
      {
        ...{ credentialId: identity.credentialId },
        enrollmentToken: '02'.repeat(32),
        minTtlMs: 300_000,
      },
    ])
  })

  test('does not reuse a successful credential when the next get refuses', async () => {
    let calls = 0
    const { custody } = fixture({
      getScoped: async () => {
        if (++calls > 1) throw new Error('revoked')
        return {
          ...identity,
          material: 'test-access',
          recordVersion: 1,
          expiresAtMs: 1_000_000,
        }
      },
    })
    expect((await custody.authorize(identity)).accessToken).toBe('test-access')
    await expect(custody.authorize(identity)).rejects.toThrow()
    expect(calls).toBe(2)
  })

  test.each([
    { credentialId: 'other' },
    { accountId: 'replacement-account' },
    { accountId: undefined },
    { expiresAtMs: 300_999 },
    { expiresAtMs: null },
    { recordVersion: NaN },
    { recordVersion: -1 },
    { material: '' },
    { material: 'claustrum-tombstone:v1:anthropic' },
    { material: 'secret\r\nheader' },
  ])('refuses invalid or changed serving identity %j', async (patch) => {
    const { custody } = fixture({
      getScoped: async () => ({
        ...identity,
        material: 'test-access',
        recordVersion: 1,
        expiresAtMs: 1_000_000,
        ...patch,
      }),
    })
    await expect(custody.authorize(identity)).rejects.toThrow('Claustrum')
  })

  test('reports only 401 using exact send-time enrollment and served version', async () => {
    const f = fixture()
    const attempt = await f.custody.authorize(identity)
    f.rotate()
    await f.custody.reportFailure(attempt, 403, 'direct')
    await f.custody.reportFailure(attempt, 429, 'direct')
    expect(f.reports).toHaveLength(0)
    await f.custody.reportFailure(attempt, 401, 'relay_status_field')
    expect(f.reports).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken: '01'.repeat(32),
        providerStatus: 401,
        recordVersion: 7,
        reporterSource: 'relay_status_field',
      },
    ])
    expect(JSON.stringify(attempt)).not.toContain('test-access')
    expect(JSON.stringify(attempt)).not.toContain('01'.repeat(32))
  })

  test('logs a delivered 401 report with its served version and no credential material', async () => {
    const f = fixture()
    const attempt = await f.custody.authorize(identity)
    const { records } = await captureLogs(() =>
      f.custody.reportFailure(attempt, 401, 'direct'),
    )
    const reported = records.filter(
      (record) => record.message === 'scoped 401 reported',
    )
    expect(reported).toHaveLength(1)
    expect(reported[0]?.payload).toEqual({
      credentialId: identity.credentialId,
      recordVersion: 7,
      reporterSource: 'direct',
    })
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain('test-access')
    expect(serialized).not.toContain('01'.repeat(32))
  })

  test('does not log a 401 report the vault did not accept', async () => {
    const f = fixture({
      reportAuthFailureScoped: async () => {
        throw new Error('vault unavailable')
      },
    })
    const attempt = await f.custody.authorize(identity)
    const { records } = await captureLogs(() =>
      f.custody.reportFailure(attempt, 401, 'direct').catch(() => {}),
    )
    expect(
      records.some((record) => record.message === 'scoped 401 reported'),
    ).toBe(false)
  })

  test('rejects a copied or foreign attempt receipt', async () => {
    const f = fixture()
    const attempt = await f.custody.authorize(identity)
    await expect(
      f.custody.reportFailure({ ...attempt }, 401, 'direct'),
    ).rejects.toThrow()
    await expect(
      fixture().custody.reportFailure(attempt, 401, 'direct'),
    ).rejects.toThrow()
  })

  test('close fences an in-flight credential reply', async () => {
    let resolve!: (
      value: Awaited<ReturnType<ClaustrumScopedClient['getScoped']>>,
    ) => void
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    const { custody } = fixture({
      getScoped: () => {
        entered()
        return new Promise((r) => {
          resolve = r
        })
      },
    })
    const pending = custody.authorize(identity)
    await started
    custody.close()
    resolve({
      ...identity,
      material: 'test-access',
      recordVersion: 1,
      expiresAtMs: 1_000_000,
    })
    await expect(pending).rejects.toThrow('closed')
  })

  test('aborted dispatch never asks the daemon for credentials', async () => {
    const f = fixture()
    await expect(
      f.custody.authorize(identity, AbortSignal.abort()),
    ).rejects.toThrow()
    expect(f.gets).toHaveLength(0)
  })
})

describe('scoped discovery', () => {
  test('filters by native protocol, not model vendor or credential ID spelling', async () => {
    const { custody } = fixture({
      listScoped: async () => ({
        view: 'changed',
        rows: [
          row,
          { ...row, id: 'arbitrary-label', accountId: 'account-2' },
          { ...row, id: 'oauth:anthropic:proxy', refreshAdapter: 'cursor' },
          {
            ...row,
            id: 'apikey:openrouter',
            credentialType: 'api_key',
            refreshAdapter: undefined,
          },
          { ...row, id: 'no-read', operations: ['sign'] },
        ],
      }),
    })
    const inventory = await custody.discover()
    expect(inventory.view).toBe('changed')
    expect(inventory.accounts.map((account) => account.credentialId)).toEqual([
      row.id,
      'arbitrary-label',
    ])
  })

  test('retains non-active inventory rows for reconciliation, not dispatch', async () => {
    const { custody } = fixture({
      listScoped: async () => ({
        view: 'changed',
        rows: [{ ...row, state: 'needs_reauth' }],
      }),
    })
    expect((await custody.discover()).accounts[0]?.state).toBe('needs_reauth')
  })

  test('missing identity refuses the inventory instead of appearing as account removal', async () => {
    const { custody } = fixture({
      listScoped: async () => ({
        view: 'changed',
        rows: [{ ...row, accountId: undefined }],
      }),
    })
    await expect(custody.discover()).rejects.toThrow()
  })
})

describe('scoped boundary failures', () => {
  test('does not coalesce overlapping authorizations', async () => {
    const f = fixture()
    await Promise.all([
      f.custody.authorize(identity),
      f.custody.authorize(identity),
    ])
    expect(f.gets).toHaveLength(2)
  })

  test('redacts unknown transport errors containing bearer params', async () => {
    const { custody } = fixture({
      getScoped: async () => {
        throw new Error(`failed params: ${'01'.repeat(32)}`)
      },
    })
    try {
      await custody.authorize(identity)
      throw new Error('authorization unexpectedly succeeded')
    } catch (error) {
      expect(String(error)).toBe(
        'Error: Claustrum scoped operation unavailable',
      )
      expect(String(error)).not.toContain('01'.repeat(32))
    }
  })

  test('rejects a malformed consumer token before daemon dispatch', async () => {
    let called = false
    const custody = new ClaustrumScopedCustody({
      client: {
        listScoped: async () => {
          called = true
          return { rows: [], view: 'empty' }
        },
        getScoped: async () => {
          throw new Error('unexpected')
        },
        reportAuthFailureScoped: async () => {},
        close: () => {},
      },
      readToken: async () => ({ token: '', token_generation: 1 }),
    })
    await expect(custody.discover()).rejects.toThrow(
      'Invalid Claustrum enrollment token',
    )
    expect(called).toBe(false)
  })

  test('accepts JSON OAuth material without exposing it in the receipt projection', async () => {
    const { custody } = fixture({
      getScoped: async () => ({
        ...identity,
        material: JSON.stringify({ access_token: 'test-json-access' }),
        recordVersion: 1,
        expiresAtMs: 1_000_000,
      }),
    })
    const attempt = await custody.authorize(identity)
    expect(attempt.accessToken).toBe('test-json-access')
    expect(JSON.stringify(attempt)).not.toContain('test-json-access')
  })
})

test('cancels an in-flight scoped get without waiting for its reply', async () => {
  let entered!: () => void
  let reply!: (
    value: Awaited<ReturnType<ClaustrumScopedClient['getScoped']>>,
  ) => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const { custody } = fixture({
    getScoped: () => {
      entered()
      return new Promise((resolve) => {
        reply = resolve
      })
    },
  })
  const controller = new AbortController()
  const pending = custody.authorize(identity, controller.signal)
  await started
  controller.abort(new Error('dispatch cancelled'))
  await expect(pending).rejects.toThrow('dispatch cancelled')
  reply({
    ...identity,
    material: 'test-access',
    recordVersion: 1,
    expiresAtMs: 1_000_000,
  })
})

test('preserves the producer contract allowing record version zero', async () => {
  const { custody } = fixture({
    getScoped: async () => ({
      ...identity,
      material: 'test-access',
      recordVersion: 0,
      expiresAtMs: 1_000_000,
    }),
  })
  expect((await custody.authorize(identity)).recordVersion).toBe(0)
})

const wireRow = {
  id: identity.credentialId,
  account_id: identity.accountId,
  type: 'oauth',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  refresh_adapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  record_version: 1,
}

test.each([
  '',
  [{ ...wireRow, operations: 'read' }],
  [{ ...wireRow, id: 123 }],
  [{ ...wireRow, account_id: 123 }],
])(
  'producer decoder rejects malformed inventory before reconciliation: %j',
  async (credentials) => {
    let calls = 0
    const client = await ClaustrumClient.connect({
      connectionFile: '/unused-test-connection',
      logger: () => {},
      connector: async () =>
        ({
          call: async () => {
            calls++
            return { result: { credentials, view: 'view' } }
          },
          close: () => {},
        }) as unknown as Awaited<ReturnType<ClaustrumConnector>>,
    })
    const custody = new ClaustrumScopedCustody({
      client,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    })
    try {
      await expect(custody.discover()).rejects.toThrow()
      expect(calls).toBe(1)
    } finally {
      custody.close()
    }
  },
)

test('only a changed record version for the same scoped credential and provider identity permits a 401 replay', () => {
  const served = {
    ...identity,
    accessToken: 'old',
    recordVersion: 7,
    expiresAtMs: 1_000_000,
  }
  expect(
    isScopedCredentialRotation(served, {
      ...served,
      accessToken: 'new',
      recordVersion: 8,
    }),
  ).toBe(true)
  for (const candidate of [
    undefined,
    { ...served, accessToken: 'new' },
    { ...served, credentialId: 'oauth:anthropic:other', recordVersion: 8 },
    { ...served, accountId: 'other-account', recordVersion: 8 },
  ]) {
    expect(isScopedCredentialRotation(served, candidate)).toBe(false)
  }
})

test('records both arms of a scoped 401 retry decision without credential material', async () => {
  const served = {
    ...identity,
    accessToken: 'served-secret',
    recordVersion: 7,
    expiresAtMs: 1_000_000,
  }
  const rotated = { ...served, accessToken: 'rotated-secret', recordVersion: 8 }
  const { result: retried, records } = await captureLogs(() => [
    decideScopedRetryAfter401('model', served, rotated),
    decideScopedRetryAfter401('cachekeep', served, { ...served }),
    decideScopedRetryAfter401('prime', served, undefined),
    decideScopedRetryAfter401('pi-model', served, {
      ...rotated,
      accountId: 'other-account',
    }),
    decideScopedRetryAfter401('pi-model-relay', served, {
      ...rotated,
      credentialId: 'oauth:anthropic:other',
    }),
  ])
  expect(retried).toEqual([true, false, false, false, false])
  expect(
    records
      .filter((record) => record.message === 'scoped 401 re-authorized')
      .map((record) => record.payload),
  ).toEqual([
    {
      site: 'model',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 8,
      retry: true,
      reason: 'rotated',
    },
    {
      site: 'cachekeep',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 7,
      retry: false,
      reason: 'version-unchanged',
    },
    {
      site: 'prime',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: null,
      retry: false,
      reason: 'reauthorize-failed',
    },
    {
      site: 'pi-model',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 8,
      retry: false,
      reason: 'account-changed',
    },
    {
      site: 'pi-model-relay',
      credentialId: identity.credentialId,
      servedVersion: 7,
      currentVersion: 8,
      retry: false,
      reason: 'credential-changed',
    },
  ])
  expect(JSON.stringify(records)).not.toContain('secret')
})
