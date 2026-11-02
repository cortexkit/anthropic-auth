import { expect, test } from 'bun:test'
import {
  type AccountStorage,
  fetchOAuthQuotaSnapshot,
  getQuotaNextRefreshAt,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  mergeHeaderQuotaForPersistence,
  type OAuthQuotaSnapshot,
  quotaBackoffActive,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotOmitsFiveHour,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
} from '../accounts.ts'
import { type InsulaClaudeQuota, mergeInsulaQuota } from '../insula-quota.ts'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../native-quota-codec.ts'
import { mergeHeaderQuotaSnapshot } from '../quota-headers.ts'
import { QuotaManager } from '../quota-manager.ts'
import { buildClaudeQuotaSummary } from '../quotas.ts'
import {
  decideStickyQuotaFailure,
  stickyQuotaSnapshotIsFresh,
  stickyRouteCandidateWeight,
} from '../sticky-routing.ts'

const model = 'claude-fable-5-1'
const storage = (): AccountStorage => ({
  version: 1,
  accounts: [],
  quota: {
    // A positive floor refuses 0% remaining; a zero floor intentionally permits it.
    minimumRemaining: { five_hour: 1, seven_day: 1 },
    failClosedOnUnknownQuota: true,
  },
})

async function poll(
  used = 0,
  checkedAt = Date.now(),
): Promise<OAuthQuotaSnapshot> {
  return {
    ...(await fetchOAuthQuotaSnapshot({
      accessToken: 'synthetic-ultra-access',
      now: () => checkedAt,
      fetchImpl: Object.assign(
        async () =>
          Response.json({
            five_hour: null,
            seven_day: {
              utilization: used,
              resets_at: new Date(checkedAt + 86400_000).toISOString(),
            },
            limits: [
              {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: 20,
                scope: { model: { id: model, display_name: 'Fable' } },
              },
            ],
          }),
        { preconnect: fetch.preconnect },
      ),
    })),
    accountIdentity: 'synthetic-ultra-account',
  }
}

const window = (checkedAt: number, remainingPercent = 100) => ({
  usedPercent: 100 - remainingPercent,
  remainingPercent,
  checkedAt,
})

test('Ultra stored weekly-only quota remains eligible after the poll interval', async () => {
  const now = Date.now()
  const quota = await poll(0, now - 301_000)
  const policy = storage()
  policy.killswitch = { enabled: true, main: { five_hour: 5, seven_day: 20 } }
  const twoWindow = { ...quota, five_hour: window(quota.checkedAt!) }
  expect(quotaSnapshotPassesPolicy(twoWindow, policy)).toBe(true)
  expect(quotaSnapshotPassesPolicy(quota, policy)).toBe(true)
  expect(killswitchPassesPolicy(quota, policy)).toBe(true)
  expect(getQuotaNextRefreshAt(quota, policy, now)).toBe(
    getQuotaNextRefreshAt(twoWindow, policy, now),
  )
  expect(stickyQuotaSnapshotIsFresh(quota, policy, now)).toBe(false)
  expect(decideStickyQuotaFailure({ quota, now })).toEqual({
    action: 'retain',
    reason: 'not-exhausted',
  })
  expect(
    decideStickyQuotaFailure({ quota: await poll(100, now - 301_000), now }),
  ).toEqual({ action: 'migrate', reason: 'seven-day' })
})

test('Ultra stored weekly-only quota remains eligible during quota API backoff', async () => {
  const now = Date.now()
  const quota = await poll(0, now - 1000)
  const policy = storage()
  policy.killswitch = { enabled: true, main: { five_hour: 5, seven_day: 20 } }
  policy.quota!.mainLastQuotaApiError = {
    checkedAt: now,
    nextRetryAt: now + 900_000,
    accountIdentity: quota.accountIdentity,
    message: 'Quota API rate-limited',
    status: 429,
  }
  expect(quotaBackoffActive(policy.quota!.mainLastQuotaApiError, now)).toBe(
    true,
  )
  expect(quotaSnapshotPassesPolicy(quota, policy)).toBe(true)
  expect(killswitchPassesPolicy(quota, policy)).toBe(true)
})

test('Ultra newer reading with an exhausted five-hour window ends the exemption', async () => {
  const now = Date.now()
  const quota = await poll(0, now - 1000)
  const incoming = {
    ...quota,
    checkedAt: now,
    five_hour: window(now, 0),
    seven_day: window(now),
  }
  const merged = fromNativeQuotaMap(
    nativeQuotaCodec.merge(toNativeQuotaMap(quota), toNativeQuotaMap(incoming)),
  )
  const policy = storage()
  policy.quota!.minimumRemaining = { five_hour: 5, seven_day: 1 }
  policy.killswitch = { enabled: true, main: { five_hour: 5, seven_day: 20 } }
  expect(merged.five_hour?.remainingPercent).toBe(0)
  expect(quotaSnapshotOmitsFiveHour(merged)).toBe(false)
  expect(quotaSnapshotPassesPolicy(merged, policy)).toBe(false)
  expect(killswitchPassesPolicy(merged, policy)).toBe(false)
})

test('Ultra omitted five-hour freshness follows the weekly window clock', async () => {
  const now = Date.now()
  const quota = await poll(0, now - 301_000)
  const harvested = mergeHeaderQuotaForPersistence(quota, {
    source: 'headers',
    checkedAt: now,
    seven_day: window(now),
  })
  expect(stickyQuotaSnapshotIsFresh(harvested, storage(), now)).toBe(true)
  expect(
    stickyRouteCandidateWeight({
      candidate: { accountId: 'main', order: 0, quota: harvested },
      family: 'general',
      storage: storage(),
      now,
    }),
  ).toBeGreaterThan(0)
})

test('Ultra successful weekly-only poll is eligible; weekly and Fable quota still block', async () => {
  const quota = await poll()
  const policy = storage()
  expect(quota.five_hour).toBeUndefined()
  expect(quotaSnapshotHasStandardWindows(quota)).toBe(true)
  expect(quotaSnapshotPassesPolicy(quota, policy)).toBe(true)
  expect(quotaSnapshotPassesModelScope(quota, model)).toBe(true)
  const exhausted = await poll(100)
  expect(quotaSnapshotPassesPolicy(exhausted, policy)).toBe(false)
  expect(decideStickyQuotaFailure({ quota: exhausted })).toEqual({
    action: 'migrate',
    reason: 'seven-day',
  })
  const scoped = {
    ...quota,
    scoped: quota.scoped!.map((entry) => ({
      ...entry,
      remainingPercent: 0,
      usedPercent: 100,
    })),
  }
  expect(quotaSnapshotPassesPolicy(scoped, policy)).toBe(true)
  expect(quotaSnapshotPassesModelScope(scoped, model)).toBe(false)
})

test('absent, header-only and missing-weekly readings remain unknown', async () => {
  const policy = storage()
  const quota = await poll()
  expect(quotaSnapshotPassesPolicy(undefined, policy)).toBe(false)
  expect(
    quotaSnapshotPassesPolicy({ ...quota, source: 'headers' }, policy),
  ).toBe(false)
  expect(
    quotaSnapshotPassesPolicy({ ...quota, seven_day: undefined }, policy),
  ).toBe(false)
  policy.quota!.failClosedOnUnknownQuota = false
  expect(quotaSnapshotPassesPolicy(undefined, policy)).toBe(true)
  expect(
    quotaSnapshotPassesPolicy(
      { ...(await poll(100)), source: 'headers' },
      policy,
    ),
  ).toBe(false)
})

test('Ultra sticky weight is nonzero, while weekly and scoped exhaustion have no weight', async () => {
  const quota = await poll()
  const weight = (reading: OAuthQuotaSnapshot) =>
    stickyRouteCandidateWeight({
      candidate: { accountId: 'main', order: 0, quota: reading },
      family: 'fable',
      modelId: model,
      storage: storage(),
    })
  expect(stickyQuotaSnapshotIsFresh(quota, storage(), Date.now(), model)).toBe(
    true,
  )
  expect(weight(quota)).toBeGreaterThan(0)
  expect(weight(await poll(100))).toBe(0)
  expect(
    weight({
      ...quota,
      scoped: quota.scoped!.map((entry) => ({ ...entry, remainingPercent: 0 })),
    }),
  ).toBe(0)
  expect(
    stickyQuotaSnapshotIsFresh(await poll(0, Date.now() - 301_000), storage()),
  ).toBe(false)
})

test('Ultra weekly killswitch floor and retry hint still apply without a session limit', async () => {
  const policy = storage()
  policy.killswitch = { enabled: true, main: { five_hour: 99, seven_day: 20 } }
  expect(killswitchPassesPolicy(await poll(), policy)).toBe(true)
  const low = await poll(90)
  expect(killswitchPassesPolicy(low, policy)).toBe(false)
  const now = Date.now()
  expect(killswitchRetryAfterSeconds(low, [], now)).toBe(300)
  expect(killswitchPassesPolicy(undefined, policy)).toBe(false)
})

test('Ultra weekly short reset holds; a long weekly or Fable reset migrates', async () => {
  const now = Date.now()
  const exhausted = await poll(100, now)
  exhausted.seven_day!.resetsAt = new Date(now + 60_000).toISOString()
  expect(
    decideStickyQuotaFailure({
      quota: exhausted,
      now,
      sessionId: 'ultra',
      holdUntil: now + 300_000,
    }),
  ).toEqual({
    action: 'hold',
    reason: 'seven-day-short-reset',
    retryAfterSeconds: 60,
  })
  exhausted.scoped![0]!.remainingPercent = 0
  exhausted.scoped![0]!.resetsAt = new Date(now + 86400_000).toISOString()
  expect(
    decideStickyQuotaFailure({ quota: exhausted, now, modelId: model }),
  ).toEqual({ action: 'migrate', reason: 'model-scoped' })
})

test('newer Ultra poll clears a stored five-hour window and older observations cannot restore it', async () => {
  const now = Date.now()
  const quota = await poll(0, now)
  const old: OAuthQuotaSnapshot = {
    ...quota,
    checkedAt: now - 1000,
    five_hour: window(now - 1000, 0),
    seven_day: window(now - 1000),
  }
  const merged = fromNativeQuotaMap(
    nativeQuotaCodec.merge(toNativeQuotaMap(old), toNativeQuotaMap(quota)),
  )
  expect(merged.five_hour).toBeUndefined()
  expect(quotaSnapshotPassesPolicy(merged, storage())).toBe(true)
  const header: OAuthQuotaSnapshot = {
    accountIdentity: quota.accountIdentity,
    source: 'headers',
    checkedAt: now - 500,
    five_hour: window(now - 500, 0),
  }
  for (const reading of [
    mergeHeaderQuotaForPersistence(merged, header),
    mergeHeaderQuotaSnapshot(merged, header),
    fromNativeQuotaMap(
      nativeQuotaCodec.merge(
        toNativeQuotaMap(merged),
        toNativeQuotaMap(header),
      ),
    ),
    fromNativeQuotaMap(
      nativeQuotaCodec.merge(toNativeQuotaMap(merged), toNativeQuotaMap(old)),
    ),
  ]) {
    expect(reading.five_hour).toBeUndefined()
    expect(quotaSnapshotOmitsFiveHour(reading)).toBe(true)
  }
  const map = toNativeQuotaMap(merged)
  expect(map.limits.map((limit) => limit.label)).not.toContain('five_hour')
  expect(Object.keys(map.anthropic).sort()).toEqual([
    'accountIdentity',
    'checkedAt',
    'fieldSources',
    'remainingPercent',
    'scoped',
    'source',
    'version',
  ])
})

test('a newer weekly header cannot keep an older session window after an Ultra poll', async () => {
  const now = Date.now()
  const quota = await poll(0, now - 100)
  const headers: OAuthQuotaSnapshot = {
    accountIdentity: quota.accountIdentity,
    source: 'headers',
    checkedAt: now,
    five_hour: window(now - 1000, 0),
    seven_day: window(now, 80),
  }
  const merged = fromNativeQuotaMap(
    nativeQuotaCodec.merge(toNativeQuotaMap(headers), toNativeQuotaMap(quota)),
  )
  expect(merged.five_hour).toBeUndefined()
  expect(merged.seven_day?.remainingPercent).toBe(80)
  expect(merged.checkedAt).toBe(quota.checkedAt)
  expect(quotaSnapshotOmitsFiveHour(merged)).toBe(true)
  const harvested = mergeHeaderQuotaSnapshot(quota, {
    ...headers,
    five_hour: undefined,
  })
  expect(harvested.checkedAt).toBe(quota.checkedAt)
  expect(stickyQuotaSnapshotIsFresh(harvested, storage(), now + 301_000)).toBe(
    false,
  )
})

test('quota manager poll completion does not restore a pre-poll harvested session window', async () => {
  const now = Date.now()
  const quota = await poll(0, now)
  const manager = new QuotaManager({
    storage: storage(),
    now: () => now,
    fetchQuotaSnapshot: async () => quota,
  })
  try {
    manager.pushMainFromHeaders(quota.accountIdentity, {
      source: 'headers',
      checkedAt: now - 1000,
      five_hour: window(now - 1000),
    })
    const refreshed = await manager.refreshMain(
      quota.accountIdentity,
      'synthetic-ultra-access',
    )
    expect(refreshed.five_hour).toBeUndefined()
  } finally {
    manager.close()
  }
})

test('shared quota display shows Ultra weekly and Fable windows without a five-hour placeholder', async () => {
  const quota = await poll()
  const summary = buildClaudeQuotaSummary({
    accounts: [{ name: 'Ultra', role: 'main', quota }],
  })
  expect(summary).toContain('7d 100% left')
  expect(summary).toContain('Fable only 80% left')
  expect(summary).not.toContain('5h')
})

test('quota manager ignores an older poll after an Ultra reading removed the session limit', async () => {
  const now = Date.now()
  const quota = await poll(0, now)
  const old: OAuthQuotaSnapshot = {
    ...quota,
    checkedAt: now - 1000,
    five_hour: window(now - 1000, 0),
    seven_day: window(now - 1000),
  }
  const manager = new QuotaManager({
    storage: storage(),
    now: () => now,
    fetchQuotaSnapshot: async () => old,
  })
  try {
    manager.setMain(quota.accountIdentity, {
      quota,
      checkedAt: now,
      refreshAfter: now + 300_000,
    })
    const refreshed = await manager.refreshMain(
      quota.accountIdentity,
      'synthetic-ultra-access',
    )
    expect(refreshed.five_hour).toBeUndefined()
    expect(refreshed.checkedAt).toBe(now)
  } finally {
    manager.close()
  }
})

test('insula merge preserves a poll-removed session limit across independently newer windows', async () => {
  const now = Date.now()
  const quota = await poll(0, now - 100)
  const reading: InsulaClaudeQuota = {
    ...quota,
    checkedAt: quota.checkedAt!,
    seven_day: quota.seven_day!,
    scoped: quota.scoped!,
  }
  const stored: OAuthQuotaSnapshot = {
    source: 'headers',
    checkedAt: now,
    five_hour: window(now - 1000, 0),
    seven_day: window(now, 80),
  }
  expect(mergeInsulaQuota(reading, stored).five_hour).toBeUndefined()
  const old: InsulaClaudeQuota = {
    ...reading,
    five_hour: window(now - 1000, 0),
    checkedAt: now - 1000,
  }
  const merged = mergeInsulaQuota(old, quota)
  expect(merged.five_hour).toBeUndefined()
  expect(merged.checkedAt).toBe(quota.checkedAt)
})
