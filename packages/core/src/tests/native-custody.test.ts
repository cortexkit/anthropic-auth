import { describe, expect, spyOn, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ClaustrumClient } from '@cortexkit/claustrum-client'
import {
  ClaustrumConsumerError,
  type ClaustrumConsumerFailureKind,
  ClaustrumCredentialError,
  type ClaustrumScopedAttempt,
  ClaustrumScopedCustody,
  type VaultInventory,
} from '@cortexkit/common-auth/claustrum'
import {
  createLogger,
  initLogger,
  resetLoggerForTest,
} from '@cortexkit/common-auth/logger'
import { moduleReferences } from '../../scripts/check-native-type-closure.ts'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import {
  createNativeCustody,
  type NativeCustodyClient,
  NativeCustodyError,
  type NativeCustodyErrorCode,
  type NativeCustodyInventory,
  type NativeCustodyOptions,
  type NativeCustodyReceipt,
} from '../native-custody.ts'

type Assert<T extends true> = T
type PublishedClient = Pick<
  ClaustrumClient,
  'listScoped' | 'getScoped' | 'reportAuthFailureScoped' | 'close'
>
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
// Compare Core's structural types with common-auth and the published client.
// Keep these dependencies in tests, outside Core's public type declarations.
export type ClientParity = Assert<Same<NativeCustodyClient, PublishedClient>>
export type ErrorParity = Assert<
  Same<NativeCustodyErrorCode, ClaustrumConsumerFailureKind>
>
export type InventoryParity = Assert<
  Same<NativeCustodyInventory, VaultInventory>
>
export type ReceiptParity = Assert<
  NativeCustodyReceipt extends ClaustrumScopedAttempt ? true : false
>

const identity = {
  credentialId: 'oauth:anthropic:work',
  accountIdentity: 'account-1',
}
const enrollmentToken = '01'.repeat(32)
const nextToken = '02'.repeat(32)
const bearer = 'synthetic-access'
type Material = Awaited<ReturnType<NativeCustodyClient['getScoped']>>
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]
const row: Row = {
  id: identity.credentialId,
  accountId: identity.accountIdentity,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  operations: ['read'],
  state: 'active',
  recordVersion: 7,
  createdAtMs: null,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(options: Partial<NativeCustodyOptions> = {}) {
  const gets: Parameters<NativeCustodyClient['getScoped']>[0][] = []
  const reports: Parameters<
    NativeCustodyClient['reportAuthFailureScoped']
  >[0][] = []
  const lists: (string | undefined)[] = []
  const counts = { connects: 0, reads: 0, closes: 0 }
  let token = { token: enrollmentToken, token_generation: 1 }
  let rows: readonly Row[] = [row]
  let material: Material = {
    credentialId: identity.credentialId,
    accountId: identity.accountIdentity,
    material: bearer,
    recordVersion: 7,
    expiresAtMs: 1_000_000,
  }
  const client: NativeCustodyClient = {
    listScoped: async (token) => {
      lists.push(token)
      return { view: 'view-1', rows }
    },
    getScoped: async (input) => {
      gets.push(input)
      return material
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
    },
    close: () => {
      counts.closes++
    },
  }
  const custody = createNativeCustody({
    host: 'opencode',
    connect: async () => {
      counts.connects++
      return client
    },
    readToken: async () => {
      counts.reads++
      return token
    },
    now: () => 1_000,
    ...options,
  })
  return {
    custody,
    client,
    gets,
    reports,
    lists,
    counts,
    token: (value: typeof token) => {
      token = value
    },
    rows: (value: readonly Row[]) => {
      rows = value
    },
    material: (patch: Partial<Material>) => {
      material = { ...material, ...patch }
    },
  }
}

async function refusal(
  pending: Promise<unknown>,
  code: NativeCustodyErrorCode,
) {
  const error = await pending.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(NativeCustodyError)
  expect((error as NativeCustodyError).code).toBe(code)
  expect((error as NativeCustodyError).message).toBe(
    `Native custody refused: ${code}`,
  )
  return error as NativeCustodyError
}

describe('historical custody controls (12 B1 + 1 migration)', () => {
  test('discovery inventory shape', async () => {
    const f = fixture()
    f.rows([
      row,
      {
        ...row,
        id: 'arbitrary-label',
        accountId: undefined,
        state: 'needs_reauth',
      },
      { ...row, id: 'wrong-category', categories: ['other'] },
      { ...row, id: 'proxy', refreshAdapter: 'cursor' },
      {
        ...row,
        id: 'key',
        credentialType: 'api_key',
        refreshAdapter: undefined,
      },
      { ...row, id: 'no-read', operations: ['sign'] },
      { ...row, id: 'blank-account', accountId: '' },
    ])
    expect(await f.custody.discover()).toEqual({
      view: 'view-1',
      credentials: [
        {
          credentialId: identity.credentialId,
          credentialType: 'oauth',
          accountIdentity: 'account-1',
          state: 'active',
        },
        {
          credentialId: 'arbitrary-label',
          credentialType: 'oauth',
          state: 'needs_reauth',
        },
      ],
      skipped: [
        { credentialId: 'blank-account', reason: 'blank account identity' },
      ],
    })
    expect(f.lists).toEqual([enrollmentToken])
    expect(f.gets).toHaveLength(0)
  })

  test('actual served identity assertion', async () => {
    const f = fixture()
    expect(await f.custody.authorize(identity)).toMatchObject({
      ...identity,
      credentialType: 'oauth',
      accountIdentitySource: 'asserted',
      expectedAccountIdentity: identity.accountIdentity,
      assertedCredentialId: identity.credentialId,
      assertedAccountIdentity: identity.accountIdentity,
      recordVersion: 7,
      expiresAtMs: 1_000_000,
    })
  })

  test('five-minute margin reaching getScoped', async () => {
    const f = fixture()
    await f.custody.authorize(identity)
    expect(f.gets).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken,
        minTtlMs: 300_000,
      },
    ])
  })

  test('bearer hidden from receipt JSON and spread', async () => {
    const f = fixture()
    const receipt = await f.custody.authorize(identity)
    expect(receipt.accessToken).toBe(bearer)
    expect(Object.getOwnPropertyDescriptor(receipt, 'accessToken')).toEqual({
      value: bearer,
      enumerable: false,
      writable: false,
      configurable: false,
    })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain(bearer)
    expect(JSON.stringify(receipt)).not.toContain(enrollmentToken)
    expect({ ...receipt }).not.toHaveProperty('accessToken')
  })

  test('original failure version', async () => {
    const f = fixture()
    const initial = await f.custody.authorize(identity)
    f.token({ token: nextToken, token_generation: 2 })
    f.material({ recordVersion: 8 })
    const retried = await f.custody.prepareRetry(initial)
    expect(retried.retry).toBe(true)
    if (!retried.retry) throw new Error('Expected a newer receipt')
    for (const status of [403, 429, 500])
      await f.custody.reportFailure(retried.receipt, status, 'direct')
    expect(f.reports).toHaveLength(0)
    f.material({ recordVersion: 9 })
    f.token({ token: enrollmentToken, token_generation: 3 })
    await Promise.all([
      f.custody.reportFailure(retried.receipt, 401, 'relay_status_field'),
      f.custody.reportFailure(retried.receipt, 401, 'relay_status_field'),
    ])
    expect(f.reports).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken: nextToken,
        providerStatus: 401,
        recordVersion: 8,
        reporterSource: 'relay_status_field',
      },
    ])
  })

  test('spread or copy cannot report', async () => {
    const f = fixture()
    const receipt = await f.custody.authorize(identity)
    const foreign = fixture()
    for (const copy of [
      { ...receipt },
      Object.assign({}, receipt),
      structuredClone(receipt),
    ]) {
      await refusal(f.custody.reportFailure(copy, 401, 'direct'), 'no-receipt')
    }
    await refusal(
      foreign.custody.reportFailure(receipt, 401, 'direct'),
      'no-receipt',
    )
    expect(f.reports).toHaveLength(0)
    expect(foreign.counts.connects).toBe(0)
    expect(foreign.reports).toHaveLength(0)
  })

  test('unknown expected identity refuses before getScoped', async () => {
    const f = fixture()
    for (const accountIdentity of [undefined, '', '   ']) {
      await refusal(
        f.custody.authorize({
          ...identity,
          accountIdentity,
        } as typeof identity),
        'identity-unasserted',
      )
    }
    expect(f.gets).toHaveLength(0)
    expect(f.counts).toEqual({ connects: 0, reads: 0, closes: 0 })
  })

  test('missing served account assertion', async () => {
    const f = fixture()
    f.material({ accountId: undefined })
    await refusal(f.custody.authorize(identity), 'identity-unasserted')
    expect(f.gets).toHaveLength(1)
    expect(f.reports).toHaveLength(0)
  })

  test('missing served credential assertion', async () => {
    const f = fixture()
    f.material({ credentialId: undefined })
    await refusal(f.custody.authorize(identity), 'identity-unasserted')
    expect(f.gets).toHaveLength(1)
  })

  test('wrong served account assertion', async () => {
    const f = fixture()
    f.material({ accountId: 'other-account' })
    await refusal(f.custody.authorize(identity), 'identity-changed')
    expect(f.gets).toHaveLength(1)
  })

  test('wrong served credential assertion', async () => {
    const f = fixture()
    f.material({ credentialId: 'other-credential' })
    await refusal(f.custody.authorize(identity), 'identity-changed')
    expect(f.gets).toHaveLength(1)
  })

  test('insufficient lifetime refusal', async () => {
    const f = fixture()
    f.material({ expiresAtMs: 300_999 })
    let receipts = 0
    let dispatched = 0
    await refusal(
      f.custody.authorize(identity).then(() => {
        receipts++
        dispatched++
      }),
      'insufficient-validity',
    )
    expect(f.gets).toEqual([
      {
        credentialId: identity.credentialId,
        enrollmentToken,
        minTtlMs: 300_000,
      },
    ])
    expect(receipts).toBe(0)
    expect(dispatched).toBe(0)
    expect(f.reports).toHaveLength(0)
  })
})

describe('authorization and receipt ownership', () => {
  test('forces OAuth despite malicious extra runtime fields and null expiry', async () => {
    const f = fixture()
    const malicious = {
      ...identity,
      credentialType: 'api_key',
      minTtlMs: 0,
      requireAssertion: false,
    }
    expect((await f.custody.authorize(malicious)).credentialType).toBe('oauth')
    f.material({ expiresAtMs: null })
    await refusal(f.custody.authorize(malicious), 'insufficient-validity')
    expect(f.gets).toHaveLength(2)
    expect(f.gets.every((input) => input.minTtlMs === 300_000)).toBe(true)
  })

  test('rereads token and does not reuse successful authorization', async () => {
    const f = fixture()
    expect(f.counts).toEqual({ connects: 0, reads: 0, closes: 0 })
    const first = await f.custody.authorize(identity)
    f.token({ token: nextToken, token_generation: 2 })
    const second = await f.custody.authorize(identity)
    expect(second).not.toBe(first)
    expect(f.counts.reads).toBe(2)
    expect(f.gets.map((input) => input.enrollmentToken)).toEqual([
      enrollmentToken,
      nextToken,
    ])
    f.client.getScoped = async () => {
      throw new Error(enrollmentToken)
    }
    await refusal(f.custody.authorize(identity), 'unavailable')
    expect(f.counts.reads).toBe(3)
  })

  test.each([
    { token: '', token_generation: 1 },
    { token: 'bad', token_generation: 1 },
    { token: enrollmentToken, token_generation: 0 },
    { token: enrollmentToken, token_generation: 1.5 },
    { token: enrollmentToken, token_generation: NaN },
    {} as { token: string; token_generation: number },
  ])('invalid enrollment refuses without scoped IPC: %j', async (token) => {
    const f = fixture()
    f.token(token)
    await refusal(f.custody.authorize(identity), 'invalid-token')
    expect(f.gets).toHaveLength(0)
    expect(f.counts.connects).toBe(0)
  })

  test('returns and reports the exact producer original', async () => {
    const originalAuthorize = ClaustrumScopedCustody.prototype.authorize
    const originals: ClaustrumScopedAttempt[] = []
    const authorized = spyOn(
      ClaustrumScopedCustody.prototype,
      'authorize',
    ).mockImplementation(async function (
      this: ClaustrumScopedCustody,
      identity,
      signal,
    ) {
      const original = await originalAuthorize.call(this, identity, signal)
      originals.push(original)
      return original
    })
    const originalReport = ClaustrumScopedCustody.prototype.reportFailure
    const reported: ClaustrumScopedAttempt[] = []
    const reporting = spyOn(
      ClaustrumScopedCustody.prototype,
      'reportFailure',
    ).mockImplementation(async function (
      this: ClaustrumScopedCustody,
      receipt,
      status,
      source,
    ) {
      reported.push(receipt)
      return originalReport.call(this, receipt, status, source)
    })
    try {
      const f = fixture()
      const initial = await f.custody.authorize(identity)
      f.material({ recordVersion: 8 })
      const retry = await f.custody.prepareRetry(initial)
      if (!retry.retry) throw new Error('Expected a retry')
      expect(initial as ClaustrumScopedAttempt).toBe(originals[0]!)
      expect(retry.receipt as ClaustrumScopedAttempt).toBe(originals[1]!)
      await f.custody.reportFailure(retry.receipt, 401, 'direct')
      expect(reported).toHaveLength(1)
      expect(reported[0]).toBe(originals[1])
    } finally {
      authorized.mockRestore()
      reporting.mockRestore()
    }
  })

  test('unexpected input is unavailable without IPC', async () => {
    const f = fixture()
    for (const invalid of [
      null,
      undefined,
      { credentialId: 123, accountIdentity: 'known' },
      { credentialId: 'id', accountIdentity: 123 },
    ]) {
      await refusal(
        f.custody.authorize(invalid as unknown as typeof identity),
        'unavailable',
      )
    }
    expect(f.counts.connects).toBe(0)
  })
})

describe('bounded non-reporting retry', () => {
  test.each([7, 6])(
    'rejects equal or older version %i with version-not-newer',
    async (version) => {
      const f = fixture()
      const served = await f.custody.authorize(identity)
      f.material({ recordVersion: version })
      const result = await f.custody.prepareRetry(served)
      expect(result).toEqual({ retry: false, reason: 'version-not-newer' })
      expect(f.gets).toHaveLength(2)
      expect(f.counts.reads).toBe(2)
      expect(f.reports).toHaveLength(0)
      expect(JSON.stringify(result)).not.toContain(bearer)
    },
  )

  test('strictly greater version retries once without reporting', async () => {
    const f = fixture()
    const served = await f.custody.authorize(identity)
    f.material({ recordVersion: 8 })
    const result = await f.custody.prepareRetry(served)
    expect(result.retry).toBe(true)
    if (!result.retry) throw new Error('Expected newer version')
    expect(result.receipt.recordVersion).toBe(8)
    expect(f.gets).toHaveLength(2)
    expect(f.counts.reads).toBe(2)
    expect(f.reports).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain(enrollmentToken)
    expect(JSON.stringify(result)).not.toContain(bearer)
  })

  test('copied or foreign receipt refuses before reauthorization', async () => {
    const f = fixture()
    const served = await f.custody.authorize(identity)
    const foreign = fixture()
    await refusal(f.custody.prepareRetry({ ...served }), 'no-receipt')
    await refusal(foreign.custody.prepareRetry(served), 'no-receipt')
    expect(f.gets).toHaveLength(1)
    expect(f.counts.reads).toBe(1)
    expect(foreign.counts.connects).toBe(0)
    expect(foreign.counts.reads).toBe(0)
    expect(f.reports).toHaveLength(0)
  })

  test('reauthorize-failed retains only the refusal code', async () => {
    const f = fixture()
    const served = await f.custody.authorize(identity)
    f.material({ accountId: 'replacement' })
    expect(await f.custody.prepareRetry(served)).toEqual({
      retry: false,
      reason: 'reauthorize-failed',
      code: 'identity-changed',
    })
    expect(f.gets).toHaveLength(2)
    expect(f.reports).toHaveLength(0)
  })

  test.each([
    {
      patch: { credentialId: 'other-credential' },
      reason: 'credential-changed',
    },
    { patch: { accountIdentity: 'other-account' }, reason: 'account-changed' },
  ])(
    'defensive retry reason $reason for a genuine alternate receipt',
    async ({ patch, reason }) => {
      const f = fixture()
      const served = await f.custody.authorize(identity)
      const alternate = { ...identity, ...patch }
      f.material({
        credentialId: alternate.credentialId,
        accountId: alternate.accountIdentity,
        recordVersion: 8,
      })
      const originalAuthorize = f.custody.authorize
      // Common-auth refuses changed assertions before the retry policy sees them.
      // The spy instead authorizes one other valid route, returning its genuine
      // receipt so the retry policy's credential/account comparisons run independently.
      const authorize = spyOn(f.custody, 'authorize').mockImplementation(
        (_identity, signal) => originalAuthorize(alternate, signal),
      )
      try {
        expect(await f.custody.prepareRetry(served)).toEqual({
          retry: false,
          reason,
        })
        expect(authorize).toHaveBeenCalledTimes(1)
        expect(authorize.mock.calls[0]?.[0]).toEqual(identity)
        expect(f.gets).toHaveLength(2)
        expect(f.reports).toHaveLength(0)
      } finally {
        authorize.mockRestore()
      }
    },
  )

  test('abort and closed propagate instead of retry refusal', async () => {
    const f = fixture()
    const served = await f.custody.authorize(identity)
    const aborted = new Error('synthetic cancellation')
    await expect(
      f.custody.prepareRetry(served, AbortSignal.abort(aborted)),
    ).rejects.toBe(aborted)
    f.custody.close()
    await refusal(f.custody.prepareRetry(served), 'closed')
    expect(f.gets).toHaveLength(1)
    expect(f.reports).toHaveLength(0)
  })

  test('closed consumer refusal during fresh reauthorization propagates', async () => {
    let closed = false
    const f = fixture({
      readToken: async () => {
        if (closed) throw new ClaustrumConsumerError('closed', enrollmentToken)
        return { token: enrollmentToken, token_generation: 1 }
      },
    })
    const served = await f.custody.authorize(identity)
    closed = true
    await refusal(f.custody.prepareRetry(served), 'closed')
    expect(f.gets).toHaveLength(1)
    expect(f.reports).toHaveLength(0)
  })

  test('abort during fresh reauthorization propagates without reporting', async () => {
    const token = deferred<{ token: string; token_generation: number }>()
    const reading = deferred<void>()
    let reads = 0
    const f = fixture({
      readToken: async () => {
        if (++reads === 1)
          return { token: enrollmentToken, token_generation: 1 }
        reading.resolve()
        return token.promise
      },
    })
    const served = await f.custody.authorize(identity)
    const controller = new AbortController()
    const pending = f.custody.prepareRetry(served, controller.signal)
    await reading.promise
    const reason = new Error('synthetic retry cancellation')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    token.resolve({ token: nextToken, token_generation: 2 })
    await token.promise
    expect(reads).toBe(2)
    expect(f.gets).toHaveLength(1)
    expect(f.reports).toHaveLength(0)
    f.custody.close()
  })
})

const consumerKinds = [
  'closed',
  'not-enrolled',
  'invalid-token',
  'unavailable',
  'identity-changed',
  'identity-unasserted',
  'insufficient-validity',
  'invalid-material',
  'not-active',
  'route-unavailable',
  'route-declined',
  'no-receipt',
  'unsafe-file',
  'invalid-state',
  'wrong-consumer',
  'roster-busy',
  'host-slot-login',
  'host-slot-placeholder',
  'placeholder-refresh',
] as const satisfies readonly ClaustrumConsumerFailureKind[]

export type ErrorTestCoverage = Assert<
  Same<(typeof consumerKinds)[number], NativeCustodyErrorCode>
>

describe('closed redacted error and logger boundary', () => {
  test.each([...consumerKinds])(
    'maps consumer kind %s to its own native code',
    async (kind) => {
      const producer = new ClaustrumConsumerError(
        kind,
        `consumer detail ${enrollmentToken} ${bearer}`,
      )
      const f = fixture({
        readToken: async () => {
          throw producer
        },
      })
      const error = await refusal(f.custody.authorize(identity), kind)
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('data')
      expect(error).not.toHaveProperty('kind')
      expect(producer).not.toHaveProperty('code')
      expect(JSON.stringify(error)).not.toContain(enrollmentToken)
      expect(String(error)).not.toContain('consumer detail')
      expect(String(error)).not.toContain(bearer)
      expect(f.gets).toHaveLength(0)
    },
  )

  test('unexpected and vault errors retain no raw message cause or data', async () => {
    const vault = new ClaustrumCredentialError(
      enrollmentToken,
      'permanent',
      'gone',
    )
    vault.message = `raw vault detail ${bearer}`
    Object.assign(vault, {
      cause: new Error(enrollmentToken),
      data: { token: enrollmentToken },
      kind: 'invalid-token',
    })
    const f = fixture()
    f.client.getScoped = async () => {
      throw vault
    }
    for (const error of [
      await refusal(f.custody.authorize(identity), 'unavailable'),
      await refusal(
        fixture({
          readToken: async () => {
            throw new Error(enrollmentToken)
          },
        }).custody.authorize(identity),
        'unavailable',
      ),
      await refusal(
        fixture({
          readToken: async () => {
            throw new ClaustrumConsumerError(
              'alien' as ClaustrumConsumerFailureKind,
              enrollmentToken,
            )
          },
        }).custody.authorize(identity),
        'unavailable',
      ),
    ]) {
      expect(Object.keys(error).sort()).toEqual(['code', 'name'])
      expect(error).not.toHaveProperty('cause')
      expect(error).not.toHaveProperty('data')
      expect(error).not.toHaveProperty('class')
      expect(JSON.stringify(error)).not.toContain(enrollmentToken)
      expect(String(error)).not.toContain(bearer)
    }
  })

  test('explicit and no-op logger functions prevent the producer default logger', async () => {
    const defaultRecords: unknown[] = []
    const records: unknown[] = []
    initLogger({
      level: 'debug',
      captureSink: (record) => {
        defaultRecords.push(record)
      },
    })
    try {
      // A direct common-auth log verifies the sink observes its default logger;
      // custody operations must bypass that logger, not merely leave it unconfigured.
      createLogger('claustrum').warn('capture companion')
      expect(defaultRecords).toHaveLength(1)
      defaultRecords.length = 0
      for (const logger of [
        undefined,
        {
          warn: (message: string, data?: unknown) => {
            records.push({ message, data })
          },
          debug: (message: string, data?: unknown) => {
            records.push({ message, data })
          },
        },
      ]) {
        const f = fixture({ logger })
        f.rows([{ ...row, id: enrollmentToken, accountId: '' }])
        await f.custody.discover()
        const receipt = await f.custody.authorize(identity)
        await f.custody.reportFailure(receipt, 401, 'direct')
      }
      expect(defaultRecords).toEqual([])
      expect(records).toEqual([
        { message: 'Native custody inventory record skipped', data: undefined },
        { message: 'Native custody failure reported', data: undefined },
      ])
      expect(JSON.stringify(records)).not.toContain(enrollmentToken)
      expect(JSON.stringify(records)).not.toContain(bearer)
    } finally {
      resetLoggerForTest()
    }
  })
})

describe('owned lazy lifecycle', () => {
  test('a later operation recovers from a rejected connection without retrying the failed operation', async () => {
    let connects = 0
    const f = fixture({
      connect: async () => {
        if (++connects === 1)
          throw new Error(`synthetic unavailable ${enrollmentToken}`)
        return f.client
      },
    })
    await refusal(f.custody.authorize(identity), 'unavailable')
    expect(connects).toBe(1)
    expect(f.counts.reads).toBe(1)
    expect(f.gets).toHaveLength(0)
    const receipt = await f.custody.authorize(identity)
    expect(receipt.accessToken).toBe(bearer)
    expect(connects).toBe(2)
    expect(f.counts.reads).toBe(2)
    expect(f.gets).toHaveLength(1)
    await f.custody.authorize(identity)
    expect(connects).toBe(2)
    expect(f.gets).toHaveLength(2)
    expect(f.reports).toHaveLength(0)
    f.custody.close()
    expect(f.counts.closes).toBe(1)
  })

  test('concurrent failed operations share one attempt and the recovery wave shares one new connection', async () => {
    const first = deferred<NativeCustodyClient>()
    const recovered = deferred<NativeCustodyClient>()
    const firstEntered = deferred<void>()
    const recoveryEntered = deferred<void>()
    let connects = 0
    const f = fixture({
      connect: () => {
        if (++connects === 1) {
          firstEntered.resolve()
          return first.promise
        }
        recoveryEntered.resolve()
        return recovered.promise
      },
    })
    const failed = Promise.all([
      refusal(f.custody.authorize(identity), 'unavailable'),
      refusal(f.custody.discover(), 'unavailable'),
      refusal(f.custody.authorize(identity), 'unavailable'),
    ])
    await firstEntered.promise
    expect(connects).toBe(1)
    first.reject(new Error('synthetic transport unavailable'))
    await failed
    expect(connects).toBe(1)
    expect(f.gets).toHaveLength(0)
    expect(f.lists).toHaveLength(0)

    const pending = Promise.all([
      f.custody.authorize(identity),
      f.custody.discover(),
      f.custody.authorize(identity),
    ])
    await recoveryEntered.promise
    expect(connects).toBe(2)
    recovered.resolve(f.client)
    const [one, inventory, two] = await pending
    expect(one).not.toBe(two)
    expect(one.accessToken).toBe(bearer)
    expect(two.accessToken).toBe(bearer)
    expect(inventory.credentials).toHaveLength(1)
    expect(connects).toBe(2)
    expect(f.counts.reads).toBe(6)
    expect(f.gets).toHaveLength(2)
    expect(f.lists).toHaveLength(1)
    expect(f.reports).toHaveLength(0)
    f.custody.close()
    expect(f.counts.closes).toBe(1)
  })

  test('close after a failed connection is terminal and leaves another instance open', async () => {
    let connects = 0
    const f = fixture({
      connect: async () => {
        connects++
        throw new Error('synthetic connect failure')
      },
    })
    const other = fixture()
    await other.custody.authorize(identity)
    await refusal(f.custody.authorize(identity), 'unavailable')
    f.custody.close()
    await refusal(f.custody.authorize(identity), 'closed')
    await refusal(f.custody.discover(), 'closed')
    expect(connects).toBe(1)
    expect(f.counts.reads).toBe(1)
    expect(f.counts.closes).toBe(0)
    expect(other.counts.closes).toBe(0)
    await other.custody.authorize(identity)
    other.custody.close()
    expect(other.counts.closes).toBe(1)
  })

  test('close during a recovering connection rejects the wave and closes only its late client', async () => {
    const recovered = deferred<NativeCustodyClient>()
    const recoveryEntered = deferred<void>()
    const lateClosed = deferred<void>()
    let connects = 0
    const f = fixture({
      connect: async () => {
        if (++connects === 1) throw new Error('synthetic connect failure')
        recoveryEntered.resolve()
        return recovered.promise
      },
    })
    const nativeClose = f.client.close
    f.client.close = () => {
      nativeClose()
      lateClosed.resolve()
    }
    const other = fixture()
    await other.custody.authorize(identity)
    await refusal(f.custody.authorize(identity), 'unavailable')
    const authorizing = f.custody.authorize(identity)
    const discovering = f.custody.discover()
    await recoveryEntered.promise
    expect(connects).toBe(2)
    f.custody.close()
    await Promise.all([
      refusal(authorizing, 'closed'),
      refusal(discovering, 'closed'),
    ])
    expect(f.counts.closes).toBe(0)
    expect(other.counts.closes).toBe(0)
    recovered.resolve(f.client)
    await lateClosed.promise
    expect(f.counts.closes).toBe(1)
    expect(f.gets).toHaveLength(0)
    expect(f.lists).toHaveLength(0)
    await refusal(f.custody.authorize(identity), 'closed')
    expect(connects).toBe(2)
    await other.custody.authorize(identity)
    other.custody.close()
    expect(other.counts.closes).toBe(1)
  })

  test('concurrent first operations share only the connection', async () => {
    const connection = deferred<NativeCustodyClient>()
    const entered = deferred<void>()
    let connects = 0
    const f = fixture({
      connect: () => {
        connects++
        entered.resolve()
        return connection.promise
      },
    })
    expect(connects).toBe(0)
    expect(f.counts.reads).toBe(0)
    const pending = Promise.all([
      f.custody.discover(),
      f.custody.authorize(identity),
      f.custody.authorize(identity),
    ])
    await entered.promise
    expect(connects).toBe(1)
    connection.resolve(f.client)
    const results = await pending
    expect(results[1]).not.toBe(results[2])
    expect(f.gets).toHaveLength(2)
    expect(f.counts.reads).toBe(3)
    f.custody.close()
    f.custody.close()
    expect(f.counts.closes).toBe(1)
  })

  test('close before connection settles rejects pending operations and closes the late owned client', async () => {
    const connection = deferred<NativeCustodyClient>()
    const entered = deferred<void>()
    const lateClosed = deferred<void>()
    const f = fixture({
      connect: () => {
        entered.resolve()
        return connection.promise
      },
    })
    const nativeClose = f.client.close
    f.client.close = () => {
      nativeClose()
      lateClosed.resolve()
    }
    const first = f.custody.authorize(identity)
    const second = f.custody.discover()
    await entered.promise
    f.custody.close()
    // Closing must reject these operations while the connect promise is still
    // unresolved. The lateClosed promise then confirms disposal of the returned client.
    await Promise.all([refusal(first, 'closed'), refusal(second, 'closed')])
    expect(f.counts.closes).toBe(0)
    connection.resolve(f.client)
    await lateClosed.promise
    expect(f.counts.closes).toBe(1)
    expect(f.gets).toHaveLength(0)
    expect(f.lists).toHaveLength(0)
    await refusal(f.custody.authorize(identity), 'closed')
  })

  test('close before use never connects and cannot close another instance', async () => {
    const first = fixture()
    const other = fixture()
    await other.custody.authorize(identity)
    first.custody.close()
    await refusal(first.custody.discover(), 'closed')
    expect(first.counts).toEqual({ connects: 0, reads: 0, closes: 0 })
    expect(other.counts.closes).toBe(0)
    await other.custody.authorize(identity)
    other.custody.close()
    expect(other.counts.closes).toBe(1)
  })

  test('close and abort fence in-flight token reads and scoped replies', async () => {
    const token = deferred<{ token: string; token_generation: number }>()
    const reading = deferred<void>()
    const f = fixture({
      readToken: () => {
        reading.resolve()
        return token.promise
      },
    })
    const pending = f.custody.authorize(identity)
    await reading.promise
    f.custody.close()
    await refusal(pending, 'closed')
    token.resolve({ token: enrollmentToken, token_generation: 1 })
    await token.promise
    expect(f.gets).toHaveLength(0)

    const reply = deferred<Material>()
    const entered = deferred<void>()
    const other = fixture()
    other.client.getScoped = () => {
      entered.resolve()
      return reply.promise
    }
    const controller = new AbortController()
    const cancelled = other.custody.authorize(identity, controller.signal)
    await entered.promise
    const reason = new Error('synthetic abort')
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    reply.resolve({
      material: bearer,
      recordVersion: 7,
      expiresAtMs: 1_000_000,
      credentialId: identity.credentialId,
      accountId: identity.accountIdentity,
    })
    await reply.promise
    other.custody.close()
  })
})

describe('synthetic default enrollment files', () => {
  test('captured host paths use the primitive safe reader with zero construction reads', async () => {
    const root = await mkdtemp(join(process.cwd(), '.native-custody-'))
    const env = { XDG_STATE_HOME: root }
    const opencode = fixture({ env, readToken: undefined })
    const pi = fixture({ env, host: 'pi', readToken: undefined })
    try {
      const openPath = getHostClaustrumEnrollmentPaths(
        'opencode',
        env,
      ).tokenPath
      const piPath = getHostClaustrumEnrollmentPaths('pi', env).tokenPath
      expect(openPath).toBe(
        join(root, 'cortexkit', 'anthropic-auth', 'opencode-enrollment.json'),
      )
      expect(piPath).toBe(
        join(root, 'cortexkit', 'anthropic-auth', 'pi-enrollment.json'),
      )
      expect(openPath).not.toBe(piPath)
      expect(opencode.counts.connects).toBe(0)
      expect(pi.counts.connects).toBe(0)
      // Construction precedes file creation. Only later authorization may read
      // these synthetic enrollment files through common-auth's tokenPath reader.
      await mkdir(dirname(openPath), { recursive: true, mode: 0o700 })
      await writeFile(
        openPath,
        JSON.stringify({ token: enrollmentToken, token_generation: 1 }),
        { mode: 0o600 },
      )
      await writeFile(
        piPath,
        JSON.stringify({ token: nextToken, token_generation: 2 }),
        { mode: 0o600 },
      )
      env.XDG_STATE_HOME = join(root, 'never-created')
      await opencode.custody.authorize(identity)
      await pi.custody.authorize(identity)
      expect(opencode.gets[0]?.enrollmentToken).toBe(enrollmentToken)
      expect(pi.gets[0]?.enrollmentToken).toBe(nextToken)
      await writeFile(
        openPath,
        JSON.stringify({ token: nextToken, token_generation: 2 }),
        { mode: 0o600 },
      )
      await opencode.custody.authorize(identity)
      expect(opencode.gets[1]?.enrollmentToken).toBe(nextToken)
      expect(opencode.counts.reads).toBe(0)
      expect(pi.counts.reads).toBe(0)
    } finally {
      opencode.custody.close()
      pi.custody.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('private-group paths accept owner-only secrets and refuse group-readable or unsafe files', async () => {
    const root = await mkdtemp(join(process.cwd(), '.native-custody-'))
    const parent = join(root, 'group-owned')
    const path = join(parent, 'opencode-enrollment.json')
    const f = fixture({
      env: { OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: path },
      readToken: undefined,
    })
    try {
      await mkdir(parent, { mode: 0o770 })
      await chmod(parent, 0o770)
      await refusal(f.custody.authorize(identity), 'not-enrolled')
      expect(f.counts.connects).toBe(0)
      await writeFile(
        path,
        JSON.stringify({ token: enrollmentToken, token_generation: 1 }),
        { mode: 0o600 },
      )
      await f.custody.authorize(identity)
      expect(f.gets).toHaveLength(1)
      await chmod(path, 0o640)
      await refusal(f.custody.authorize(identity), 'unsafe-file')
      await chmod(path, 0o600)
      await writeFile(path, JSON.stringify({ token: '', token_generation: 1 }))
      await refusal(f.custody.authorize(identity), 'invalid-token')
      await writeFile(path, `{ malformed ${enrollmentToken}`)
      const error = await refusal(
        f.custody.authorize(identity),
        'invalid-state',
      )
      expect(JSON.stringify(error)).not.toContain(enrollmentToken)
      await rm(path)
      const target = join(parent, 'synthetic-token.json')
      await writeFile(
        target,
        JSON.stringify({ token: enrollmentToken, token_generation: 1 }),
        { mode: 0o600 },
      )
      await symlink(target, path)
      await refusal(f.custody.authorize(identity), 'unsafe-file')
      expect(f.gets).toHaveLength(1)
    } finally {
      f.custody.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('native custody declaration has no producer or internal-types edge', async () => {
  const source = await readFile(
    new URL('../../dist/native-custody.d.ts', import.meta.url),
    'utf8',
  )
  const references = moduleReferences(source).map(
    (reference) => reference.specifier,
  )
  expect(
    references.filter(
      (specifier) =>
        specifier === '@cortexkit/common-auth' ||
        specifier.startsWith('@cortexkit/common-auth/'),
    ),
  ).toEqual([])
  expect(
    references.filter(
      (specifier) =>
        specifier.startsWith('.') &&
        specifier.split('/').includes('internal-types'),
    ),
  ).toEqual([])
})
