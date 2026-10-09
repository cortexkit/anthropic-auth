import { expect, test } from 'bun:test'

import {
  fetchOAuthQuotaSnapshot,
  type OAuthQuotaSnapshot,
  QUOTA_URL,
} from '../accounts.ts'
import {
  fromNativeQuotaMap,
  NativeQuotaCodecError,
  toNativeQuotaMap,
} from '../native-quota-codec.ts'

const checkedAt = 1700000000000
const syntheticAccount = {
  provenSynthetic: true,
  identity: 'synthetic-quota-normalization-account',
  accessToken: 'synthetic-quota-normalization-token',
} as const
const resetISO = '2026-10-10T12:34:56.000Z'

// This is the usage shape for a poll with unknown standard reset times.
const reportUsage = {
  five_hour: { utilization: 40, resets_at: null },
  seven_day: { utilization: 13, resets_at: null },
  limits: [
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 22,
      scope: { model: { id: 'claude-fable-5-1', display_name: 'Fable' } },
    },
  ],
}

function usageWithReset(reset: Record<string, unknown>) {
  return {
    five_hour: { utilization: 40, ...reset },
    seven_day: { utilization: 13, ...reset },
    limits: reportUsage.limits.map((limit) => ({ ...limit, ...reset })),
  }
}

async function decodeUsage(usage: unknown): Promise<OAuthQuotaSnapshot> {
  let requests = 0
  const fetchImpl: typeof fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      requests += 1
      expect(url).toBe(QUOTA_URL)
      expect(init?.method).toBe('GET')
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${syntheticAccount.accessToken}`,
      })
      return Response.json(usage)
    },
    { preconnect: fetch.preconnect },
  )
  const snapshot = await fetchOAuthQuotaSnapshot({
    accessToken: syntheticAccount.accessToken,
    now: () => checkedAt,
    fetchImpl,
  })
  expect(requests).toBe(1)
  // The fetch decoder does not own account identity; attach only a synthetic one.
  return { ...snapshot, accountIdentity: syntheticAccount.identity }
}

function expectedQuota(scoped: boolean, resetsAt?: string): OAuthQuotaSnapshot {
  const reset = resetsAt === undefined ? {} : { resetsAt }
  return {
    accountIdentity: syntheticAccount.identity,
    checkedAt,
    source: 'poll',
    fieldSources: { five_hour: 'poll', seven_day: 'poll', scoped: 'poll' },
    five_hour: { usedPercent: 40, remainingPercent: 60, checkedAt, ...reset },
    seven_day: { usedPercent: 13, remainingPercent: 87, checkedAt, ...reset },
    scoped: scoped
      ? [
          {
            id: 'claude-weekly-scoped-claude-fable-5-1',
            title: 'Fable only',
            modelId: 'claude-fable-5-1',
            modelName: 'Fable',
            usedPercent: 22,
            remainingPercent: 78,
            checkedAt,
            ...reset,
          },
        ]
      : [],
  }
}

function assertNativeRoundtrip(
  snapshot: OAuthQuotaSnapshot,
  expected: OAuthQuotaSnapshot,
) {
  expect(() => fromNativeQuotaMap(toNativeQuotaMap(snapshot))).not.toThrow()
  const map = toNativeQuotaMap(snapshot)
  const roundtrip = fromNativeQuotaMap(JSON.parse(JSON.stringify(map)))
  expect(roundtrip).toEqual(expected)
  expect(roundtrip).toEqual(JSON.parse(JSON.stringify(snapshot)))
  expect(Object.hasOwn(snapshot, 'scoped')).toBe(true)
  expect(Object.hasOwn(roundtrip, 'scoped')).toBe(true)
  return map
}

test('null quota resets normalize through the fetch decoder and native roundtrip', async () => {
  const cases = [
    reportUsage,
    usageWithReset({ resets_at: null }),
    { ...reportUsage, limits: [] },
  ]
  for (const usage of cases) {
    const snapshot = await decodeUsage(usage)
    const map = assertNativeRoundtrip(
      snapshot,
      expectedQuota(usage.limits.length > 0),
    )
    expect(snapshot.five_hour?.resetsAt).toBeUndefined()
    expect(snapshot.seven_day?.resetsAt).toBeUndefined()
    for (const window of snapshot.scoped ?? []) {
      expect(window.resetsAt).toBeUndefined()
    }
    for (const reading of map.limits) {
      expect(Object.hasOwn(reading, 'resetsAt')).toBe(false)
    }
  }
})

test('absent quota resets preserve usage and empty scoped ownership through native roundtrip', async () => {
  const usage = usageWithReset({})
  for (const limits of [usage.limits, []]) {
    const snapshot = await decodeUsage({ ...usage, limits })
    assertNativeRoundtrip(snapshot, expectedQuota(limits.length > 0))
  }
})

test('valid ISO quota resets preserve exact strings through the fetch decoder and native roundtrip', async () => {
  const usage = usageWithReset({ resets_at: resetISO })
  for (const limits of [usage.limits, []]) {
    const snapshot = await decodeUsage({ ...usage, limits })
    const map = assertNativeRoundtrip(
      snapshot,
      expectedQuota(limits.length > 0, resetISO),
    )
    for (const reading of map.limits) {
      expect(reading.kind).toBe('reading')
      if (reading.kind === 'reading') {
        expect(reading.resetsAt).toBe('2026-10-10T12:34:56.000Z')
      }
    }
  }
})

const unsupportedResets = [
  ['number', 0],
  ['boolean', false],
  ['object', {}],
  ['array', []],
] as const

for (const location of ['five_hour', 'seven_day', 'weekly_scoped'] as const) {
  for (const [type, value] of unsupportedResets) {
    test(`${location} ${type} reset is not silently normalized or accepted by the native codec`, async () => {
      const usage = usageWithReset({})
      if (location === 'weekly_scoped') {
        Object.assign(usage.limits[0]!, { resets_at: value })
      } else {
        Object.assign(usage[location], { resets_at: value })
      }
      const snapshot = await decodeUsage(usage)
      const window =
        location === 'weekly_scoped' ? snapshot.scoped?.[0] : snapshot[location]
      const resetValue: unknown = window?.resetsAt
      expect(resetValue).toEqual(value)
      expect(() => toNativeQuotaMap(snapshot)).toThrow(NativeQuotaCodecError)
    })
  }
}
