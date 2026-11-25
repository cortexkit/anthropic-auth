import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test'
import { logger } from '../logger.ts'
import { reportRoutingResponse } from '../routing-reports.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const original = globals[key]
const subject = { accountIdentity: 'account', credentialId: 'credential' }
afterEach(() => {
  setSystemTime()
  if (original === undefined) delete globals[key]
  else globals[key] = original
})

test.each([
  'full',
  '99 percent',
  'past reset',
  'Opus',
  '5h headers',
  'other scoped headers',
] as const)(
  'a 429 only uses stored Fable usage evidence when it qualifies: %s',
  async (fixture) => {
    setSystemTime(new Date('2026-11-25T23:16:00Z'))
    const reports: unknown[] = []
    const refused = {
      accountIdentity: '6faa4906-6648-4119-8b9b-77ccf0121ba8',
      credentialId: 'oauth:anthropic:dogaseker',
    }
    const headers = new Headers({
      'anthropic-ratelimit-unified-7d-utilization': '0.64',
    })
    if (fixture === '5h headers')
      headers.set('anthropic-ratelimit-unified-5h-status', 'rejected')
    if (fixture === 'other scoped headers')
      headers.set('anthropic-ratelimit-unified-7d_opus-status', 'rejected')
    const resetsAt =
      fixture === 'past reset' ? '2026-11-25T14:00:00Z' : '2026-11-27T14:00:00Z'
    const remainingPercent = fixture === '99 percent' ? 1 : 0
    globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
    reportRoutingResponse(
      'ses_ff62ce462ffe6w3gKG1wPcHK6N',
      refused,
      headers,
      429,
      fixture === 'Opus' ? 'claude-opus-5-5' : 'claude-fable-5-2',
      false,
      async () => ({
        accountIdentity: refused.accountIdentity,
        source: 'headers',
        fieldSources: { seven_day: 'headers', scoped: 'poll' },
        seven_day: {
          usedPercent: 64,
          remainingPercent: 36,
          checkedAt: Date.now(),
        },
        scoped: [
          {
            id: 'claude-weekly-scoped-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 100 - remainingPercent,
            remainingPercent,
            checkedAt: Date.now(),
            resetsAt,
          },
        ],
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    const identity = {
      account_id: refused.accountIdentity,
      credential_id: refused.credentialId,
    }
    expect(reports).toEqual(
      fixture === 'full'
        ? [
            {
              ...identity,
              outcome: 'exhausted',
              window: '7d',
              pool: 'fable',
            },
          ]
        : fixture === '5h headers'
          ? [{ ...identity, outcome: 'exhausted', window: '5h' }]
          : [],
    )
  },
)

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

test('unconfirmed headers do not use rounded utilization or claims without a full scoped poll', async () => {
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
      return undefined
    },
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(reports).toEqual([])
  expect(reads).toBe(1)
})

test('routing logs one content-free diagnostic per upstream HTTP 429', async () => {
  globals[key] = () => ({ report: () => {} })
  const debug = spyOn(logger, 'debug').mockImplementation(() => {})
  try {
    const headers = new Headers({
      'request-id': 'req_debug429',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': '2000000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.64',
      'anthropic-ratelimit-new-timestamp': '2026-11-27T14:00:00.270331+00:00',
      'anthropic-ratelimit-new-field': 'untrusted header value',
      'anthropic-ratelimit-other-status': 'unrecognized-status',
      authorization: 'not logged',
      'custom-header': 'not logged',
    })
    reportRoutingResponse('session', subject, headers, 429)
    reportRoutingResponse(
      'session',
      subject,
      headers,
      429,
      undefined,
      false,
      undefined,
      false,
    )
    reportRoutingResponse('session', subject, headers, 200)
    reportRoutingResponse('session', subject, new Headers(), 429)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(debug.mock.calls).toEqual([
      [
        'routing-relay',
        'Anthropic HTTP 429 routing report',
        {
          requestId: 'req_debug429',
          rateLimitHeaders: {
            'anthropic-ratelimit-unified-5h-status': 'rejected',
            'anthropic-ratelimit-unified-5h-reset': '2000000000',
            'anthropic-ratelimit-unified-7d-utilization': '0.64',
            'anthropic-ratelimit-new-timestamp':
              '2026-11-27T14:00:00.270331+00:00',
            'anthropic-ratelimit-new-field': null,
            'anthropic-ratelimit-other-status': null,
          },
          exhaustedReports: [{ window: '5h' }],
        },
      ],
      [
        'routing-relay',
        'Anthropic HTTP 429 routing report',
        {
          rateLimitHeaders: {},
          exhaustedReports: [],
          noReportReason: 'no_confirmed_window',
        },
      ],
    ])
  } finally {
    debug.mockRestore()
  }
})

test.each([
  ['Fable', 'fable'],
  ['Claude-Fable-5-Pool', 'claude-fable-5-pool'],
  ['not a pool', 'fable'],
  ['Fable/other', 'fable'],
] as const)(
  'a valid stored pool takes precedence over the explicit Fable scope: %s',
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
    expect(reports).toEqual([
      {
        account_id: 'account',
        credential_id: 'credential',
        outcome: 'exhausted',
        window: '7d',
        pool: expectedPool,
      },
    ])
  },
)

test('an unrecognized scoped header does not guess a routing pool', async () => {
  const reports: unknown[] = []
  globals[key] = () => ({ report: (report: unknown) => reports.push(report) })
  reportRoutingResponse(
    'session',
    subject,
    new Headers({
      'anthropic-ratelimit-unified-7d_newpool-status': 'rejected',
    }),
    429,
    'claude-newpool-5',
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(reports).toEqual([])
})

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
