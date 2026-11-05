import { expect, spyOn, test } from 'bun:test'
import { isQuotaMap } from '@cortexkit/common-auth/quota'

import {
  fetchOAuthQuotaSnapshot,
  getScopedQuotaWindowForModel,
  mergeHeaderQuotaForPersistence,
  type OAuthQuotaSnapshot,
  quotaSnapshotCheckedAt,
} from '../accounts.ts'
import {
  fromNativeQuotaMap,
  type NativeQuotaMap,
  nativeQuotaCodec,
  nativeQuotaModelScope,
  toNativeQuotaMap,
} from '../native-quota-codec.ts'
import { normalizeQuotaHeaders } from '../quota-headers.ts'

// Different timestamps expose accidental timestamp reuse between quota windows.
const full: OAuthQuotaSnapshot = {
  accountIdentity: 'synthetic-account-A',
  checkedAt: 1234,
  five_hour: {
    usedPercent: 99.96,
    remainingPercent: 0.04,
    checkedAt: 1100,
    resetsAt: '2030-01-01T05:00:00.000Z',
  },
  seven_day: {
    usedPercent: 43.125,
    remainingPercent: 56.875,
    checkedAt: 900,
    resetsAt: '2030-01-07T00:00:00.000Z',
  },
  scoped: [
    {
      id: 'claude-weekly-scoped-fable',
      title: 'Fable only',
      modelId: 'claude-fable-5',
      modelName: 'Claude Fable 5',
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: 1000,
      resetsAt: '2030-01-06T00:00:00.000Z',
    },
    {
      id: 'claude-weekly-scoped-mythos',
      title: 'Mythos only',
      modelName: 'Mythos',
      usedPercent: 0.125,
      remainingPercent: 99.875,
      checkedAt: 800,
    },
  ],
  extraUsage: {
    used: { amountMinor: 192.25, currency: 'USD', exponent: 2 },
    limit: { amountMinor: 1000, currency: 'USD', exponent: 2 },
    utilizationPercent: 19.225,
    severity: 'normal',
    exhausted: false,
  },
  bindingWindow: 'seven_day',
  bindingWindowSource: 'poll',
  fallbackAdvised: false,
  source: 'headers',
  fieldSources: {
    five_hour: 'headers',
    seven_day: 'poll',
    scoped: 'poll',
    extraUsage: 'poll',
    bindingWindow: 'poll',
    fallbackAdvised: 'headers',
  },
}

test('quota full fixture preserves independent timestamps, scope, provenance and extra usage', () => {
  const map = toNativeQuotaMap(full)
  expect(isQuotaMap(map)).toBe(true)
  expect(map.limits).toEqual([
    {
      scope: 'all',
      label: 'five_hour',
      kind: 'reading',
      usedPercent: 99.96,
      checkedAt: 1100,
      resetsAt: '2030-01-01T05:00:00.000Z',
    },
    {
      scope: 'all',
      label: 'seven_day',
      kind: 'reading',
      usedPercent: 43.125,
      checkedAt: 900,
      resetsAt: '2030-01-07T00:00:00.000Z',
    },
    {
      scope: 'fable',
      label: 'seven_day:claude-weekly-scoped-fable',
      kind: 'reading',
      usedPercent: 100,
      checkedAt: 1000,
      resetsAt: '2030-01-06T00:00:00.000Z',
    },
    {
      scope: 'mythos',
      label: 'seven_day:claude-weekly-scoped-mythos',
      kind: 'reading',
      usedPercent: 0.125,
      checkedAt: 800,
    },
  ])
  expect(map.budget).toEqual({
    kind: 'reading',
    checkedAt: 1234,
    reached: false,
    usedPercent: 19.225,
  })
  expect(fromNativeQuotaMap(map)).toEqual(full)
  expect(fromNativeQuotaMap(JSON.parse(JSON.stringify(map)))).toEqual(full)
  expect(quotaSnapshotCheckedAt(fromNativeQuotaMap(map))).toBe(1234)
  expect(
    getScopedQuotaWindowForModel(
      fromNativeQuotaMap(map),
      'anthropic/claude-fable-5@fast',
    )?.remainingPercent,
  ).toBe(0)
})

test('quota decoding detaches nested metadata without another JSON round-trip clone', () => {
  const map = toNativeQuotaMap(full)
  const before = structuredClone(map)
  const parses = spyOn(JSON, 'parse')
  const serializes = spyOn(JSON, 'stringify')
  let decoded: OAuthQuotaSnapshot
  try {
    decoded = fromNativeQuotaMap(map)
    expect(parses).not.toHaveBeenCalled()
    // Shared quota validation serializes limit-key pairs, not whole snapshots.
    expect(serializes.mock.calls.every(([value]) => Array.isArray(value))).toBe(
      true,
    )
  } finally {
    parses.mockRestore()
    serializes.mockRestore()
  }
  expect(decoded).toEqual(full)
  decoded.extraUsage!.used.amountMinor = 999
  decoded.scoped![0]!.title = 'Changed'
  decoded.fieldSources!.five_hour = 'poll'
  expect(map).toEqual(before)
})

test('quota canonical validation still rejects explicit undefineds, holes and duplicate scoped ids', () => {
  const map = toNativeQuotaMap(full)
  const malformed: unknown[] = [
    { ...map, anthropic: { ...map.anthropic, source: undefined } },
    {
      ...map,
      anthropic: {
        ...map.anthropic,
        extraUsage: { ...map.anthropic.extraUsage, severity: undefined },
      },
    },
    {
      ...map,
      limits: map.limits.map((limit) => ({ ...limit, resetsAt: undefined })),
    },
    {
      limits: [],
      anthropic: { version: 1, remainingPercent: {}, scoped: Array(1) },
    },
    {
      ...map,
      anthropic: {
        ...map.anthropic,
        scoped: [map.anthropic.scoped![0], map.anthropic.scoped![0]],
      },
    },
  ]
  for (const value of malformed) {
    expect(() => fromNativeQuotaMap(value)).toThrow()
    expect(nativeQuotaCodec.validate(value)).toBe(false)
  }
  const negativeZero = toNativeQuotaMap({ checkedAt: 0 })
  negativeZero.anthropic.checkedAt = -0
  expect(Object.is(fromNativeQuotaMap(negativeZero).checkedAt, -0)).toBe(true)
})

test('quota encoding retains the existing serialized field order and undefined normalization', () => {
  const snapshot: OAuthQuotaSnapshot = {
    checkedAt: 10,
    source: 'poll',
    five_hour: {
      usedPercent: 12.5,
      remainingPercent: 87.5,
      checkedAt: 9,
      resetsAt: undefined,
    },
  }
  const bytes =
    '{"limits":[{"scope":"all","label":"five_hour","kind":"reading","usedPercent":12.5,"checkedAt":9}],"anthropic":{"version":1,"remainingPercent":{"five_hour":87.5},"checkedAt":10,"source":"poll"}}'
  expect(JSON.stringify(toNativeQuotaMap(snapshot))).toBe(bytes)
  expect(
    JSON.stringify(toNativeQuotaMap(fromNativeQuotaMap(JSON.parse(bytes)))),
  ).toBe(bytes)
})

test('quota timestamp metadata control preserves a windowless empty scoped observation', () => {
  const empty: OAuthQuotaSnapshot = {
    accountIdentity: 'synthetic-account-A',
    checkedAt: 2000,
    scoped: [],
    source: 'poll',
    fieldSources: { scoped: 'poll' },
  }
  const map = toNativeQuotaMap(empty)
  expect(map.limits).toEqual([])
  expect(map.anthropic.checkedAt).toBe(2000)
  expect(map.anthropic.scoped).toEqual([])
  expect(fromNativeQuotaMap(map)).toEqual(empty)
  expect(quotaSnapshotCheckedAt(fromNativeQuotaMap(map))).toBe(2000)
})

test('quota scoped metadata control preserves scoped-only ownership versus missing', () => {
  const scoped: OAuthQuotaSnapshot = {
    scoped: [
      {
        id: 'weekly-custom',
        title: 'Custom only',
        modelId: 'claude-custom-1',
        modelName: 'Custom',
        usedPercent: 22.125,
        remainingPercent: 77.875,
        checkedAt: 456,
        resetsAt: '2030-02-01T00:00:00Z',
      },
    ],
  }
  const map = toNativeQuotaMap(scoped)
  expect(map.limits).toEqual([
    {
      scope: 'model:claudecustom1',
      label: 'seven_day:weekly-custom',
      kind: 'reading',
      usedPercent: 22.125,
      checkedAt: 456,
      resetsAt: '2030-02-01T00:00:00Z',
    },
  ])
  expect(fromNativeQuotaMap(map)).toEqual(scoped)
  expect(fromNativeQuotaMap(toNativeQuotaMap({}))).toEqual({})
  expect(
    Object.hasOwn(fromNativeQuotaMap(toNativeQuotaMap({})), 'scoped'),
  ).toBe(false)
  expect(fromNativeQuotaMap(toNativeQuotaMap({ scoped: [] }))).toEqual({
    scoped: [],
  })
})

test('extra usage without a clock stays lossless without fabricated budget freshness', () => {
  const quota: OAuthQuotaSnapshot = {
    extraUsage: {
      used: { amountMinor: 11, currency: 'EUR', exponent: 3 },
      limit: { amountMinor: 10, currency: 'EUR', exponent: 3 },
      exhausted: true,
    },
  }
  const map = toNativeQuotaMap(quota)
  expect(Object.hasOwn(map, 'budget')).toBe(false)
  expect(fromNativeQuotaMap(map)).toEqual(quota)
  expect(
    toNativeQuotaMap({
      five_hour: {
        usedPercent: 3.14,
        remainingPercent: 96.86,
        checkedAt: 0,
        resetsAt: undefined,
      },
    }).limits,
  ).toEqual([
    {
      scope: 'all',
      label: 'five_hour',
      kind: 'reading',
      usedPercent: 3.14,
      checkedAt: 0,
    },
  ])
  expect(nativeQuotaModelScope('ALL')).toBe('model:all')
})

test('scoped family attribution matches native model names even with an opaque provider model id', () => {
  const quota: OAuthQuotaSnapshot = {
    scoped: [
      {
        id: 'weekly-opaque',
        title: 'Fable only',
        modelId: 'provider-model-123',
        modelName: 'Fable 5',
        usedPercent: 100,
        remainingPercent: 0,
        checkedAt: 1,
      },
    ],
  }
  expect(getScopedQuotaWindowForModel(quota, 'claude-fable-5@fast')?.id).toBe(
    'weekly-opaque',
  )
  expect(toNativeQuotaMap(quota).limits).toEqual([
    {
      scope: 'fable',
      label: 'seven_day:weekly-opaque',
      kind: 'reading',
      usedPercent: 100,
      checkedAt: 1,
    },
  ])
})

test('quota extension is closed and cannot hide foreign or contradictory shared data', () => {
  const map = toNativeQuotaMap(full)
  const malformed: unknown[] = [
    { ...map, secret: 'synthetic-secret' },
    { ...map, anthropic: { ...map.anthropic, version: 2 } },
    { ...map, anthropic: { ...map.anthropic, secret: 'synthetic-secret' } },
    {
      ...map,
      limits: [
        ...map.limits,
        {
          scope: 'all',
          label: 'unowned',
          kind: 'reading',
          usedPercent: 7,
          checkedAt: 8,
        },
      ],
    },
    {
      ...map,
      limits: map.limits.map((entry) => ({ ...entry, windowMinutes: 300 })),
    },
    {
      ...map,
      budget: {
        kind: 'reading',
        checkedAt: 1234,
        reached: true,
        usedPercent: 19.225,
      },
    },
    {
      ...map,
      anthropic: { ...map.anthropic, remainingPercent: { five_hour: 0.04 } },
    },
    {
      ...map,
      limits: map.limits.map((entry) => ({
        ...entry,
        kind: 'retired',
        retiredAt: 333,
      })),
    },
    { limits: [] },
  ]
  for (const input of malformed) {
    expect(nativeQuotaCodec.validate(input)).toBe(false)
    expect(() => fromNativeQuotaMap(input)).toThrow(
      'Anthropic quota observation is invalid',
    )
  }
  expect(() =>
    toNativeQuotaMap({
      scoped: [
        {
          id: 'same',
          title: 'A',
          modelName: 'A',
          checkedAt: 1,
          usedPercent: 1,
          remainingPercent: 99,
        },
        {
          id: 'same',
          title: 'B',
          modelName: 'B',
          checkedAt: 1,
          usedPercent: 2,
          remainingPercent: 98,
        },
      ],
    }),
  ).toThrow()
})

test('store codec follows native header/poll merge and refuses cross-account provenance', () => {
  const poll: OAuthQuotaSnapshot = { ...full, source: 'poll' }
  const headers: OAuthQuotaSnapshot = {
    accountIdentity: 'synthetic-account-A',
    source: 'headers',
    checkedAt: 1400,
    five_hour: { usedPercent: 12.5, remainingPercent: 87.5, checkedAt: 1400 },
    fieldSources: { five_hour: 'headers' },
  }
  const merged = fromNativeQuotaMap(
    nativeQuotaCodec.merge(toNativeQuotaMap(poll), toNativeQuotaMap(headers)),
  )
  expect(merged).toEqual(
    JSON.parse(JSON.stringify(mergeHeaderQuotaForPersistence(poll, headers))),
  )
  expect(merged.scoped).toEqual(full.scoped)
  expect(merged.seven_day?.checkedAt).toBe(900)
  expect(merged.five_hour?.checkedAt).toBe(1400)
  expect(
    fromNativeQuotaMap(
      nativeQuotaCodec.merge(
        toNativeQuotaMap(poll),
        toNativeQuotaMap({
          accountIdentity: 'synthetic-account-A',
          checkedAt: 1,
          source: 'poll',
        }),
      ),
    ),
  ).toEqual(poll)
  expect(
    fromNativeQuotaMap(
      nativeQuotaCodec.merge(undefined, toNativeQuotaMap(headers)),
    ),
  ).toEqual(headers)
  expect(() =>
    nativeQuotaCodec.merge(
      toNativeQuotaMap(poll),
      toNativeQuotaMap({ ...headers, accountIdentity: 'synthetic-account-B' }),
    ),
  ).toThrow()
})

test('captured Team poll and response headers survive the production provider parsers and codec', async () => {
  const capture = {
    five_hour: { utilization: 77 },
    seven_day: { utilization: 40 },
    limits: [
      { kind: 'session', group: 'session', percent: 77, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: false },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 51,
        is_active: false,
        scope: { model: { id: null, display_name: 'Fable' } },
      },
    ],
    extra_usage: {
      is_enabled: true,
      monthly_limit: 10000,
      used_credits: 10035,
      utilization: 100,
    },
    spend: {
      severity: 'critical',
      limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      can_purchase_credits: false,
    },
  }
  const fetchImpl: typeof fetch = Object.assign(
    async () => Response.json(capture),
    { preconnect: fetch.preconnect },
  )
  const snapshot = await fetchOAuthQuotaSnapshot({
    accessToken: 'synthetic-fixture-token',
    now: () => 1700000000000,
    fetchImpl,
  })
  const map = toNativeQuotaMap(snapshot)
  expect(map.limits).toEqual([
    {
      scope: 'all',
      label: 'five_hour',
      kind: 'reading',
      usedPercent: 77,
      checkedAt: 1700000000000,
    },
    {
      scope: 'all',
      label: 'seven_day',
      kind: 'reading',
      usedPercent: 40,
      checkedAt: 1700000000000,
    },
    {
      scope: 'fable',
      label: 'seven_day:claude-weekly-scoped-fable',
      kind: 'reading',
      usedPercent: 51,
      checkedAt: 1700000000000,
    },
  ])
  expect(map.budget).toEqual({
    kind: 'reading',
    checkedAt: 1700000000000,
    reached: true,
    usedPercent: 100,
  })
  expect(fromNativeQuotaMap(map)).toEqual(JSON.parse(JSON.stringify(snapshot)))
  const headers = normalizeQuotaHeaders(
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.78',
      'anthropic-ratelimit-unified-5h-reset': '1784246400',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '1784628000',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-fallback': 'available',
    }),
    1700000000001,
  )
  expect(toNativeQuotaMap(headers).limits).toEqual([
    {
      scope: 'all',
      label: 'five_hour',
      kind: 'reading',
      usedPercent: 78,
      checkedAt: 1700000000001,
      resetsAt: '2026-07-17T00:00:00.000Z',
    },
    {
      scope: 'all',
      label: 'seven_day',
      kind: 'reading',
      usedPercent: 40,
      checkedAt: 1700000000001,
      resetsAt: '2026-07-21T10:00:00.000Z',
    },
  ])
  expect(fromNativeQuotaMap(toNativeQuotaMap(headers))).toEqual(headers)
})

test('the older-poll gap cannot be closed without a storage-format change because legacy data loses the poll clock', () => {
  const emptyPoll = (checkedAt: number) =>
    toNativeQuotaMap({
      accountIdentity: 'synthetic-account-A',
      source: 'poll',
      checkedAt,
      five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt },
      seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt },
      scoped: [],
    })
  const headers = toNativeQuotaMap({
    accountIdentity: 'synthetic-account-A',
    source: 'headers',
    checkedAt: 2000,
    five_hour: { usedPercent: 12, remainingPercent: 88, checkedAt: 2000 },
    seven_day: { usedPercent: 21, remainingPercent: 79, checkedAt: 2000 },
  })
  const history = (pollAt: number) =>
    nativeQuotaCodec.merge(
      nativeQuotaCodec.merge(undefined, emptyPoll(pollAt)),
      headers,
    ) as NativeQuotaMap
  const earlierPollAt = 1000
  const laterPollAt = 1500
  const latePollAt = 1200
  const first = history(earlierPollAt)
  const second = history(laterPollAt)
  // Headers replace the snapshot and shared-window clocks. An empty poll has
  // no scoped-window clock, and fieldSources stores labels rather than times.
  expect(first).toEqual(second)
  expect(first.anthropic.source).toBe('headers')
  expect(first.anthropic.checkedAt).toBe(2000)
  const latePoll = toNativeQuotaMap({
    accountIdentity: 'synthetic-account-A',
    source: 'poll',
    checkedAt: latePollAt,
    five_hour: { usedPercent: 30, remainingPercent: 70, checkedAt: latePollAt },
    seven_day: { usedPercent: 40, remainingPercent: 60, checkedAt: latePollAt },
    scoped: [
      {
        id: 'fable',
        title: 'Fable',
        modelName: 'Fable',
        checkedAt: latePollAt,
        usedPercent: 50,
        remainingPercent: 50,
      },
    ],
    extraUsage: full.extraUsage,
  })
  const afterFirst = fromNativeQuotaMap(nativeQuotaCodec.merge(first, latePoll))
  const afterSecond = fromNativeQuotaMap(
    nativeQuotaCodec.merge(second, latePoll),
  )
  // The newest-poll rule would accept the late poll only after the earlier
  // history, but identical legacy inputs cannot distinguish those outcomes.
  expect(latePollAt > earlierPollAt).toBe(true)
  expect(latePollAt > laterPollAt).toBe(false)
  expect(afterFirst).toEqual(afterSecond)
  expect(afterFirst.scoped).toEqual([])
  expect(afterFirst.extraUsage).toBeUndefined()
})

test('a newer complete poll replaces the whole snapshot and clears older scoped limits and extra usage', () => {
  const stored = toNativeQuotaMap({ ...full, source: 'poll' })
  for (const scoped of [undefined, []] as const) {
    const incoming: OAuthQuotaSnapshot = {
      accountIdentity: full.accountIdentity,
      source: 'poll',
      checkedAt: 2000,
      five_hour: { usedPercent: 12, remainingPercent: 88, checkedAt: 2000 },
      ...(scoped !== undefined ? { scoped: [...scoped] } : {}),
    }
    const merged = fromNativeQuotaMap(
      nativeQuotaCodec.merge(stored, toNativeQuotaMap(incoming)),
    )
    expect(merged).toEqual(incoming)
    expect(merged.scoped ?? []).toEqual([])
    expect(merged.extraUsage).toBeUndefined()
  }
})
