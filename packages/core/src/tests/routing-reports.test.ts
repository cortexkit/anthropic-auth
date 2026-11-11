import { afterEach, expect, test } from 'bun:test'
import { reportRoutingResponse } from '../routing-reports.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const original = globals[key]
const subject = { accountIdentity: 'account', credentialId: 'credential' }
afterEach(() => {
  if (original === undefined) delete globals[key]
  else globals[key] = original
})

test('raw rejected and full windows report independently with their own resets', async () => {
  const reports: unknown[] = []
  globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
  expect(
    reportRoutingResponse(
      'session',
      subject,
      new Headers({
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '0.996',
        'anthropic-ratelimit-unified-5h-reset': '2000000000',
        'anthropic-ratelimit-unified-7d-utilization': '1',
        'anthropic-ratelimit-unified-7d-reset': '2000000100',
      }),
      429,
    ),
  ).toBeUndefined()
  await Promise.resolve()
  expect(reports).toEqual([
    {
      account_id: 'account',
      credential_id: 'credential',
      outcome: 'exhausted',
      window: '5h',
      resets_at: 2_000_000_000_000,
    },
    {
      account_id: 'account',
      credential_id: 'credential',
      outcome: 'exhausted',
      window: '7d',
      resets_at: 2_000_000_100_000,
    },
  ])
})

test('unconfirmed headers do not use rounded utilization, claims or saved quota', async () => {
  const reports: unknown[] = []
  let reads = 0
  globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
  reportRoutingResponse(
    'session',
    subject,
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.996',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'retry-after': '432000',
    }),
    429,
    'claude-fable-5',
    false,
    async () => {
      reads++
      throw new Error('An unconfirmed window must not read saved quota')
    },
  )
  await Promise.resolve()
  expect(reports).toEqual([])
  expect(reads).toBe(0)
})

test.each([
  ['Fable', 'fable'],
  ['Claude-Fable-5-Pool', 'claude-fable-5-pool'],
  ['not a pool', undefined],
  ['Fable/other', undefined],
] as const)(
  'scoped reports require a valid stored pool identity: %s',
  async (pool, expectedPool) => {
    const reports: unknown[] = []
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    reportRoutingResponse(
      'session',
      subject,
      new Headers({
        'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
      }),
      429,
      'claude-fable-5',
      false,
      async () => ({
        scoped: [
          {
            id: 'claude-weekly-scoped-fable',
            title: 'Fable only',
            modelName: 'Fable',
            modelId: pool,
            usedPercent: 20,
            remainingPercent: 80,
            checkedAt: Date.now(),
          },
        ],
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(reports).toEqual(
      expectedPool === undefined
        ? []
        : [
            {
              account_id: 'account',
              credential_id: 'credential',
              outcome: 'exhausted',
              window: '7d',
              pool: expectedPool,
            },
          ],
    )
  },
)

test('missing account identity or accessor cannot report or read storage', async () => {
  let calls = 0
  const readQuota = async () => {
    calls++
    return undefined
  }
  globals[key] = () => ({
    report: () => {
      calls++
    },
  })
  const headers = new Headers({
    'anthropic-ratelimit-unified-7d_fable-status': 'rejected',
  })
  reportRoutingResponse(
    'session',
    {},
    headers,
    429,
    'claude-fable-5',
    false,
    readQuota,
  )
  await Promise.resolve()
  delete globals[key]
  reportRoutingResponse(
    'session',
    subject,
    headers,
    429,
    'claude-fable-5',
    false,
    readQuota,
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(0)
})

test('a header parser throw is detached from the caller', async () => {
  globals[key] = () => ({
    report: () => {
      throw new Error('not reached')
    },
  })
  class UnreadableHeaders extends Headers {
    override readonly get = (): string | null => {
      throw new Error('headers unavailable')
    }
  }
  expect(
    reportRoutingResponse('session', subject, new UnreadableHeaders(), 429),
  ).toBeUndefined()
  await Promise.resolve()
  await Promise.resolve()
})
