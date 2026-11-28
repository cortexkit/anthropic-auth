import { expect, test } from 'bun:test'
import { type OAuthQuotaSnapshot, quotaPollCheckedAt } from '../accounts.ts'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../native-quota-codec.ts'
import {
  type NativeQuotaObservation,
  NativeQuotaObservations,
} from '../native-quota-observations.ts'
import { normalizeQuotaHeaders } from '../quota-headers.ts'

const pollAt = 1_700_000_000_000
const headerAt = pollAt + 1
const accountId = 'main'
const accountUuid = crypto.randomUUID()
const lineage = 'synthetic-lineage'
const storage = { version: 1 as const, accounts: [] }
const poll: OAuthQuotaSnapshot = {
  accountIdentity: accountUuid,
  checkedAt: pollAt,
  source: 'poll',
  five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: pollAt },
  seven_day: { usedPercent: 20, remainingPercent: 80, checkedAt: pollAt },
  scoped: [
    {
      id: 'fable',
      title: 'Fable',
      modelName: 'Fable',
      usedPercent: 70,
      remainingPercent: 30,
      checkedAt: pollAt,
    },
  ],
  extraUsage: {
    used: { amountMinor: 40, currency: 'USD', exponent: 2 },
    limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
    utilizationPercent: 40,
    severity: 'normal',
    exhausted: false,
  },
}
const headers: OAuthQuotaSnapshot = {
  ...normalizeQuotaHeaders(
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-5h-reset': '1700003600',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
      'anthropic-ratelimit-unified-7d-reset': '1700604800',
    }),
    headerAt,
  ),
  accountIdentity: accountUuid,
}

function observation(
  quota: OAuthQuotaSnapshot,
  checkedAt: number,
): NativeQuotaObservation {
  return {
    lineage,
    accountUuid,
    generalExhausted: false,
    entry: { quota, checkedAt, refreshAfter: checkedAt },
    ...(quota.source === 'headers' ? { routeBeforeSave: true } : {}),
  }
}

function merge(
  stored: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
) {
  return fromNativeQuotaMap(
    nativeQuotaCodec.merge(
      stored ? toNativeQuotaMap(stored) : undefined,
      toNativeQuotaMap(incoming),
    ),
  )
}

function pollFields(quota: OAuthQuotaSnapshot | undefined) {
  return { scoped: quota?.scoped, extraUsage: quota?.extraUsage }
}

test('control: newer headers retain poll-owned fields once the first poll is committed', () => {
  const merged = merge(merge(undefined, poll), headers)
  expect(merged.five_hour?.checkedAt).toBe(headerAt)
  expect(merged.seven_day?.checkedAt).toBe(headerAt)
  expect(pollFields(merged)).toEqual(pollFields(poll))
})

test('newer header-only quota cannot erase the first full poll before its detached write', async () => {
  const observations = new NativeQuotaObservations()
  let committed: OAuthQuotaSnapshot | undefined
  const overlay = () =>
    observations.quota(lineage, accountUuid, committed, storage, headerAt)
      ?.quota
  try {
    const firstPublication = observations.publish(
      accountId,
      observation(poll, pollAt),
      async () => {
        committed = merge(committed, poll)
        return true
      },
    )
    expect(pollFields(overlay())).toEqual(pollFields(poll))
    expect(observations.hold(accountId, observation(headers, headerAt))).toBe(
      true,
    )
    const beforeSave = overlay()
    expect(beforeSave?.five_hour?.checkedAt).toBe(headerAt)
    expect(beforeSave?.seven_day?.checkedAt).toBe(headerAt)
    committed = merge(committed, headers)
    await firstPublication
    expect({
      beforeSave: pollFields(beforeSave),
      afterSave: pollFields(committed),
    }).toEqual({
      beforeSave: pollFields(poll),
      afterSave: pollFields(poll),
    })
  } finally {
    await observations.close()
  }
})

test('a kept poll overlays its committed copy without changing it', async () => {
  const observations = new NativeQuotaObservations()
  const committed = merge(undefined, poll)
  try {
    const held = observation(headers, headerAt)
    observations.hold(accountId, held)
    let saved = false
    await observations.publish(
      accountId,
      observation(poll, pollAt),
      async () => {
        saved = true
        return true
      },
    )
    expect(saved).toBe(true)
    observations.forget(accountId, held)
    expect(observations.get(accountId)).toBeUndefined()
    expect(
      observations.quota(lineage, accountUuid, committed, storage, headerAt)
        ?.quota,
    ).toEqual(committed)
  } finally {
    await observations.close()
  }
})

test('a refused poll no longer overlays the header held during its write', async () => {
  const observations = new NativeQuotaObservations()
  const held = observation(headers, headerAt)
  const overlay = () =>
    observations.quota(lineage, accountUuid, undefined, storage, headerAt)
      ?.quota
  try {
    const publication = observations.publish(
      accountId,
      observation(poll, pollAt),
      async () => false,
    )
    observations.hold(accountId, held)
    expect(pollFields(overlay())).toEqual(pollFields(poll))
    await publication
    expect(observations.get(accountId)).toBe(held)
    expect(overlay()).toEqual(merge(undefined, headers))
  } finally {
    await observations.close()
  }
})

function pollReading(checkedAt: number): OAuthQuotaSnapshot {
  return {
    ...poll,
    checkedAt,
    five_hour: { ...poll.five_hour!, checkedAt },
    seven_day: { ...poll.seven_day!, checkedAt },
    scoped: poll.scoped!.map((window) => ({ ...window, checkedAt })),
  }
}

test('the newest poll keeps its fields when two polls arrive out of order beneath stored headers', () => {
  const newer = pollReading(pollAt)
  const older = {
    ...pollReading(pollAt - 1),
    extraUsage: undefined,
    scoped: [],
  }
  const afterNewer = merge(merge(undefined, headers), newer)
  expect(quotaPollCheckedAt(afterNewer)).toBe(pollAt)
  const afterOlder = merge(afterNewer, older)
  expect(afterOlder.five_hour).toEqual(headers.five_hour)
  expect(afterOlder.seven_day).toEqual(headers.seven_day)
  expect(pollFields(afterOlder)).toEqual(pollFields(newer))
  expect(afterOlder).toEqual(afterNewer)
})

test('a delayed weekly-only poll cannot restore fields retired by a full poll before newer headers', () => {
  const retired = { ...pollReading(pollAt), scoped: [], extraUsage: undefined }
  const stored = merge(merge(undefined, retired), headers)
  const delayed = { ...pollReading(pollAt - 1), five_hour: undefined }
  expect(quotaPollCheckedAt(stored)).toBe(pollAt)
  expect(merge(stored, delayed)).toEqual(stored)
  expect(stored.scoped).toEqual([])
  expect(stored.extraUsage).toBeUndefined()
})

test('a first current-format poll fills missing fields after headers cover a legacy poll', () => {
  const legacy = {
    ...pollReading(pollAt),
    scoped: undefined,
    extraUsage: undefined,
  }
  const stored = merge(merge(undefined, legacy), headers)
  expect(quotaPollCheckedAt(stored)).toBe(0)
  expect(pollFields(stored)).toEqual({
    scoped: undefined,
    extraUsage: undefined,
  })
  const delayed = pollReading(pollAt - 1)
  const updated = merge(stored, delayed)
  expect(updated.five_hour).toEqual(stored.five_hour)
  expect(updated.seven_day).toEqual(stored.seven_day)
  expect(pollFields(updated)).toEqual(pollFields(delayed))
})

test('a same-millisecond header tie keeps a cleared scoped array even with no recoverable poll clock', () => {
  const retired = {
    ...pollReading(headerAt),
    scoped: [],
    extraUsage: undefined,
  }
  // A header tied with the poll first keeps the poll windows. A second
  // header at the same time replaces them, leaving only the empty array.
  const stored = merge(merge(merge(undefined, retired), headers), headers)
  expect(quotaPollCheckedAt(stored)).toBe(0)
  expect(stored.five_hour).toEqual(headers.five_hour)
  expect(stored.seven_day).toEqual(headers.seven_day)
  expect(stored.scoped).toEqual([])
  expect(stored.extraUsage).toBeUndefined()
  expect(merge(stored, poll)).toEqual(stored)
})
