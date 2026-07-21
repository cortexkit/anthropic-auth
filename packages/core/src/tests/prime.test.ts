import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  type LogTestRecord,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
// Source-side logger import — installed as a second sink so PrimeManager logs
// (which are emitted through the in-package logger instance loaded via the
// relative `./logger.ts` path) reach the test capture array. The dist logger
// instance is the package-alias target used by other tests; both must be
// wired to keep sink assertions consistent across runs.
import {
  __setLogTestSink as __setLogTestSinkSource,
  getLogLevel,
  setLogLevel as setLogLevelSource,
} from '../logger.ts'
import { CLAUDE_HAIKU_4_5_MODEL_ID } from '../models.ts'
import type { PrimeRefreshResult } from '../prime.ts'
import {
  buildPrimeAccountStatuses,
  buildPrimeStatusSummary,
  CLAUDE_HAIKU_4_5_PRICING,
  estimatePrimeCostUsd,
  executePrimeCommand,
  PRIME_CHECK_THROTTLE_MS,
  PRIME_DUE_OFFSET_MS,
  PRIME_POST_FIRE_REFRESH_MS,
  type PrimeAccountStatus,
  PrimeManager,
  type PrimeSendResult,
  type PrimeUsageCounters,
  parsePrimeCommandAction,
  primeAccountMarkerDir,
  primeIsEligible,
  primeMarkerPath,
} from '../prime.ts'

const STORAGE_TS = 1_721_111_111_000
const DUE_TS = STORAGE_TS - 60_000
const ISO_DUE = new Date(DUE_TS).toISOString()

function storage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [
      {
        id: 'work-alt',
        type: 'oauth',
        refresh: 'r',
        enabled: true,
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: ISO_DUE,
            checkedAt: STORAGE_TS,
          },
        },
        prime: {
          count: 1,
          inputTokens: 20,
          outputTokens: 1,
          since: 1_721_111_112_000,
        },
      },
    ],
  }
}

describe('parsePrimeCommandAction', () => {
  test('empty → status', () => {
    expect(parsePrimeCommandAction('')).toEqual({ type: 'status' })
  })
  test('on → enable', () => {
    expect(parsePrimeCommandAction('on')).toEqual({ type: 'enable' })
  })
  test('off → disable', () => {
    expect(parsePrimeCommandAction('off')).toEqual({ type: 'disable' })
  })
  test('anything else → usage', () => {
    expect(parsePrimeCommandAction('hello')).toEqual({ type: 'usage' })
    expect(parsePrimeCommandAction('on extra')).toEqual({ type: 'usage' })
  })
})

describe('estimatePrimeCostUsd', () => {
  test('zero usage is zero', () => {
    expect(
      estimatePrimeCostUsd({
        count: 0,
        inputTokens: 0,
        outputTokens: 0,
        since: 0,
      }),
    ).toBe(0)
  })
  test('derives cost from recorded response usage', () => {
    expect(
      estimatePrimeCostUsd({
        count: 1,
        inputTokens: 137,
        outputTokens: 2,
        since: 1,
      }),
    ).toBeCloseTo(
      (137 * CLAUDE_HAIKU_4_5_PRICING.input +
        2 * CLAUDE_HAIKU_4_5_PRICING.output) /
        1_000_000,
      9,
    )
  })
  test('undefined usage → 0', () => {
    expect(estimatePrimeCostUsd(undefined)).toBe(0)
  })
})

describe('buildPrimeAccountStatuses', () => {
  test('synthetic main + enabled fallback; nextDueAt derived from resetsAt', () => {
    const statuses = buildPrimeAccountStatuses(storage(), { now: STORAGE_TS })
    expect(statuses).toHaveLength(2)
    const main = statuses.find((s) => s.id === 'main')
    expect(main?.label).toBe('main')
    expect(main?.usage).toBeUndefined()
    expect(main?.estimatedCostUsd).toBe(0)
    const fallback = statuses.find((s) => s.id === 'work-alt')
    expect(fallback?.label).toBe('work-alt')
    expect(fallback?.nextDueAt).toBe(DUE_TS + 60_000)
    expect(fallback?.usage?.count).toBe(1)
    expect(fallback?.estimatedCostUsd).toBeCloseTo(
      (20 * CLAUDE_HAIKU_4_5_PRICING.input +
        1 * CLAUDE_HAIKU_4_5_PRICING.output) /
        1_000_000,
      9,
    )
  })

  test('omits disabled and api-key fallbacks', () => {
    const s = storage()
    s.accounts.push({ id: 'apikey-1', type: 'api', baseURL: 'https://x.y' })
    s.accounts.push({
      id: 'disabled-fb',
      type: 'oauth',
      refresh: 'r',
      enabled: false,
    })
    const statuses = buildPrimeAccountStatuses(s, { now: STORAGE_TS })
    expect(statuses.map((x) => x.id)).toEqual(['main', 'work-alt'])
  })

  test('manager transient overlay overrides runtime state', () => {
    const transient = new Map<
      string,
      { lastPrimedAt?: number; lastResult?: 'ok' | 'error' }
    >()
    transient.set('work-alt', { lastPrimedAt: 999, lastResult: 'error' })
    const statuses = buildPrimeAccountStatuses(storage(), {
      now: STORAGE_TS,
      transient,
    })
    const fb = statuses.find((s) => s.id === 'work-alt') as PrimeAccountStatus
    expect(fb.lastPrimedAt).toBe(999)
    expect(fb.lastResult).toBe('error')
  })

  test('undefined nextDueAt when no resetsAt', () => {
    const s = storage()
    s.accounts = []
    const statuses = buildPrimeAccountStatuses(s, { now: STORAGE_TS })
    const main = statuses.find((s) => s.id === 'main') as PrimeAccountStatus
    expect(main.nextDueAt).toBeUndefined()
  })
})

describe('buildPrimeStatusSummary', () => {
  test('shows status, accounts, counts, cost', () => {
    const accounts: PrimeAccountStatus[] = [
      {
        id: 'main',
        label: 'main',
        nextDueAt: null,
        usage: {
          count: 12,
          inputTokens: 240,
          outputTokens: 12,
          since: 1,
        },
        estimatedCostUsd:
          (240 * CLAUDE_HAIKU_4_5_PRICING.input +
            12 * CLAUDE_HAIKU_4_5_PRICING.output) /
          1_000_000,
      },
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: DUE_TS + 60_000,
        usage: { count: 0, inputTokens: 0, outputTokens: 0, since: 1 },
        estimatedCostUsd: 0,
      },
    ]
    const summary = buildPrimeStatusSummary({ enabled: true, accounts })
    expect(summary).toContain('## Claude Prime Status')
    expect(summary).toContain('main · ')
    expect(summary).toContain('work-alt · next prime')
    expect(summary).toContain('12 primes')
    expect(summary).toContain('\u2248 $')
  })
})

describe('executePrimeCommand', () => {
  const accounts: PrimeAccountStatus[] = [
    {
      id: 'main',
      label: 'main',
      nextDueAt: null,
      usage: { count: 0, inputTokens: 0, outputTokens: 0, since: 1 },
      estimatedCostUsd: 0,
    },
  ]

  test('status returns title without updated', () => {
    const r = executePrimeCommand({
      argumentsText: '',
      enabled: true,
      accounts,
    })
    expect(r.updated).toBeUndefined()
    expect(r.text).toContain('## Claude Prime Status')
  })

  test('on returns updated { enabled: true }', () => {
    const r = executePrimeCommand({
      argumentsText: 'on',
      enabled: true,
      accounts,
    })
    expect(r.updated).toEqual({ enabled: true })
  })

  test('off returns updated { enabled: false }', () => {
    const r = executePrimeCommand({
      argumentsText: 'off',
      enabled: true,
      accounts,
    })
    expect(r.updated).toEqual({ enabled: false })
  })

  test('unknown args returns usage text', () => {
    const r = executePrimeCommand({
      argumentsText: 'maybe',
      enabled: false,
      accounts,
    })
    expect(r.updated).toBeUndefined()
    expect(r.text).toContain('Usage')
  })

  test('does not persist or mutate anything', () => {
    const r = executePrimeCommand({
      argumentsText: 'on',
      enabled: false,
      accounts,
    })
    expect(typeof r.text).toBe('string')
    expect(r.updated).toEqual({ enabled: true })
  })
})

// -- PrimeManager ----------------------------------------------------------

interface SendCall {
  accountId: 'main' | string
  result: PrimeSendResult
}

function makePrimeFixture(opts?: {
  enabled?: boolean
  mainQuota?: OAuthQuotaSnapshot
  fallbackQuota?: OAuthQuotaSnapshot
  fallbackEnabled?: boolean
  fallbackType?: 'oauth' | 'api'
  fallbackPermanent?: boolean
  killswitch?: AccountStorage['killswitch']
}) {
  const accountId = 'work-alt'
  const accounts: AccountStorage['accounts'] = []
  if (opts?.fallbackType !== undefined) {
    if (opts.fallbackType === 'api') {
      accounts.push({
        id: accountId,
        type: 'api',
        baseURL: 'https://example.com',
      })
    } else {
      accounts.push({
        id: accountId,
        type: 'oauth',
        refresh: 'r',
        enabled: opts.fallbackEnabled !== false,
        ...(opts.fallbackPermanent && {
          lastRefreshError: {
            message: 'invalid_grant',
            checkedAt: 1,
            status: 400,
            permanent: true,
          },
        }),
        ...(opts.fallbackQuota && { quota: opts.fallbackQuota }),
      } as OAuthAccount)
    }
  }
  const storage: AccountStorage = {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    quota: opts?.mainQuota
      ? {
          enabled: true,
          checkIntervalMinutes: 5,
          mainQuota: opts.mainQuota,
          mainQuotaCheckedAt: 1,
          mainQuotaToken: 'fp',
        }
      : undefined,
    killswitch: opts?.killswitch,
    prime: { enabled: true },
    accounts,
  }
  return { storage, accountId }
}

interface Harness {
  manager: PrimeManager
  sendCalls: SendCall[]
  refreshCalls: string[]
  recordSuccessCalls: Array<{
    accountId: 'main' | string
    usage: { inputTokens?: number; outputTokens?: number }
    returnCounters: PrimeUsageCounters
  }>
  records: LogTestRecord[]
  markerDir: string
  cleanup: () => Promise<void>
}

async function makeHarness(opts: {
  storage: AccountStorage
  markerDir: string
  now: number
  quotaFresh: OAuthQuotaSnapshot
  quotaFreshIsStale?: boolean
  send?: (id: 'main' | string) => PrimeSendResult | Promise<PrimeSendResult>
  recordSuccessReturn?: PrimeUsageCounters
  refreshError?: Error
  storagePath?: string
}): Promise<Harness> {
  const sendCalls: SendCall[] = []
  const refreshCalls: string[] = []
  const recordSuccessCalls: Harness['recordSuccessCalls'] = []

  const storagePath = opts.storagePath ?? join(opts.markerDir, 'accounts.json')
  const manager = new PrimeManager({
    storagePath,
    loadStorage: async () => opts.storage,
    getAccountFingerprint: async () => '0123456789abcdef',
    refreshQuota: async (id) => {
      refreshCalls.push(id)
      if (opts.refreshError) throw opts.refreshError
      const result: PrimeRefreshResult = {
        quota: opts.quotaFresh,
        fresh: opts.quotaFreshIsStale !== true,
      }
      return result
    },
    sendPrime: async (id) => {
      const result = opts.send
        ? await opts.send(id)
        : {
            ok: true,
            status: 200,
            ms: 1,
            usage: { inputTokens: 20, outputTokens: 1 },
          }
      sendCalls.push({ accountId: id, result })
      return result
    },
    recordSuccess: async (accountId, usage) => {
      const counters = opts.recordSuccessReturn ?? {
        count: 1,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        since: opts.now,
      }
      recordSuccessCalls.push({ accountId, usage, returnCounters: counters })
      return counters
    },
    now: () => opts.now,
    markerDir: opts.markerDir,
  })

  return {
    manager,
    sendCalls,
    refreshCalls,
    recordSuccessCalls,
    records: [],
    markerDir: primeAccountMarkerDir(
      opts.markerDir,
      storagePath,
      '0123456789abcdef',
    ),
    cleanup: async () => {
      manager.stop()
    },
  }
}

let markerRoot: string
let capturedPrimeSink: LogTestRecord[] = []

beforeEach(async () => {
  markerRoot = await mkdtemp(join(tmpdir(), 'prime-manager-test-'))
  capturedPrimeSink = []
  const sink = (r: LogTestRecord) => {
    capturedPrimeSink.push(r)
  }
  __setLogTestSink(sink)
  __setLogTestSinkSource(sink)
})

afterEach(async () => {
  __setLogTestSink(null)
  __setLogTestSinkSource(null)
  if (markerRoot) {
    await rm(markerRoot, { recursive: true, force: true }).catch(() => {})
  }
})

describe('PrimeManager — due boundary', () => {
  test('resetsAt + 59s is not yet due', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 1_000_000 + 59_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          ...(fixture.storage.quota?.mainQuota?.five_hour as {
            usedPercent: number
            remainingPercent: number
            resetsAt: string
            checkedAt: number
          }),
        },
      },
    })
    await h.manager.tick()
    expect(h.refreshCalls).toEqual([])
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('resetsAt + 61s is due and fires', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 1_000_000 + 61_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_000 - 1).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls.map((c) => c.accountId)).toEqual(['main'])
    expect(h.recordSuccessCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — bootstrap', () => {
  test('missing stored reset with an inactive fresh window fires using the stable bootstrap marker', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: undefined,
          checkedAt: 1,
        },
      },
    })
    const now = 7_234_567
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null as unknown as string,
          checkedAt: 2,
        },
      },
    })

    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls.map((call) => call.accountId)).toEqual(['main'])
    expect(await readdir(h.markerDir)).toEqual(['main-bootstrap'])
    await h.cleanup()
  })

  test('missing stored reset with a future fresh reset records an active window without firing', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    const now = 7_234_567
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now + 60_000).toISOString(),
          checkedAt: 2,
        },
      },
    })

    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls).toEqual([])
    expect(h.manager.isWindowActive('main')).toBe(true)
    expect(await readdir(markerRoot)).toEqual([])
    await h.cleanup()
  })

  test('killswitch-blocked bootstrap checks quota at most once per five minutes', async () => {
    const fixture = makePrimeFixture({
      killswitch: { enabled: true, main: { five_hour: 5 } },
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    const initialNow = 7_200_000
    let now = initialNow
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: null as unknown as string,
          checkedAt: 2,
        },
      },
    })
    h.manager.options.now = () => now

    await h.manager.tick()
    now = initialNow + 60_000
    await h.manager.tick()
    now = initialNow + 4 * 60_000
    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls).toEqual([])

    now = initialNow + 5 * 60_000
    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main', 'main'])
    await h.cleanup()
  })

  test('killswitch-blocked past reset checks quota at most once per five minutes', async () => {
    const storedReset = 7_000_000
    const fixture = makePrimeFixture({
      killswitch: { enabled: true, main: { five_hour: 5 } },
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(storedReset).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const initialNow = storedReset + 120_000
    let now = initialNow
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(storedReset).toISOString(),
          checkedAt: 2,
        },
      },
    })
    h.manager.options.now = () => now

    await h.manager.tick()
    now = initialNow + 60_000
    await h.manager.tick()
    now = initialNow + 4 * 60_000
    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls).toEqual([])

    now = initialNow + 5 * 60_000
    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main', 'main'])
    await h.cleanup()
  })

  test('a newly passed stored reset bypasses a recent forced-check throttle', async () => {
    const initialReset = 9_800_000
    const initialNow = 10_000_000
    const fixture = makePrimeFixture({
      killswitch: { enabled: true, main: { five_hour: 5 } },
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(initialReset).toISOString(),
          checkedAt: 1,
        },
      },
    })
    let now = initialNow
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(initialReset).toISOString(),
          checkedAt: 2,
        },
      },
    })
    h.manager.options.now = () => now

    await h.manager.tick()
    now += 60_000
    await h.manager.tick()
    expect(h.refreshCalls).toEqual(['main'])

    const newlyPassedReset = initialNow
    fixture.storage.quota!.mainQuota!.five_hour!.resetsAt = new Date(
      newlyPassedReset,
    ).toISOString()
    now += 60_000
    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main', 'main'])
    await h.cleanup()
  })

  test('an existing bootstrap marker suppresses a fresh-check in another manager', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    const now = 7_234_567
    const fresh: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: 2,
      },
    }
    const firing = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    await firing.manager.tick()
    expect(firing.sendCalls).toHaveLength(1)

    const observing = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    await observing.manager.tick()
    await observing.manager.tick()

    expect(observing.refreshCalls).toEqual([])
    expect(observing.sendCalls).toEqual([])
    await firing.cleanup()
    await observing.cleanup()
  })

  test('observing a reset does not expose a claim gap to a stale manager', async () => {
    const staleFixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    const observedFixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    const now = 7_234_567
    const fresh: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: 2,
      },
    }
    const observing = await makeHarness({
      storage: observedFixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })

    await observing.manager.tick()
    expect(observing.sendCalls).toHaveLength(1)
    observedFixture.storage.quota!.mainQuota!.five_hour!.resetsAt = new Date(
      now + 60_000,
    ).toISOString()
    await observing.manager.tick()

    const stale = await makeHarness({
      storage: staleFixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    await stale.manager.tick()

    expect(stale.refreshCalls).toEqual([])
    expect(stale.sendCalls).toEqual([])
    expect(await readdir(observing.markerDir)).toEqual(['main-bootstrap'])
    await observing.cleanup()
    await stale.cleanup()
  })

  test('persistent reset unavailability produces one bootstrap fire across hours', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    let now = 14_400_000 - 30_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 2,
        },
      },
    })
    h.manager.options.now = () => now

    await h.manager.tick()
    now += 5 * 60_000
    await h.manager.tick()
    now += 60 * 60_000
    await h.manager.tick()
    now += 60 * 60_000
    await h.manager.tick()

    expect(h.sendCalls).toHaveLength(1)
    expect(h.refreshCalls).toEqual(['main'])
    expect(await readdir(h.markerDir)).toEqual(['main-bootstrap'])
    await h.cleanup()
  })

  test('a real reset replaces the bootstrap marker only after its epoch claim', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    let now = 10_000_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: null as unknown as string,
          checkedAt: 2,
        },
      },
    })
    h.manager.options.now = () => now

    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    expect(await readdir(h.markerDir)).toEqual(['main-bootstrap'])

    const observedReset = 11_000_000
    fixture.storage.quota!.mainQuota!.five_hour!.resetsAt = new Date(
      observedReset,
    ).toISOString()
    await h.manager.tick()
    expect(await readdir(h.markerDir)).toEqual(['main-bootstrap'])

    now = observedReset + PRIME_DUE_OFFSET_MS + 1
    await h.manager.tick()

    expect(h.sendCalls).toHaveLength(2)
    expect(await readdir(h.markerDir)).toEqual([`main-${observedReset}`])
    await h.cleanup()
  })
})

describe('PrimeManager — fresh-check', () => {
  test('future resetsAt → skip + no claim', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: new Date(now + 5 * 60_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    await h.cleanup()
  })

  test('absent five_hour fires (inactive-window shape 1)', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: { scoped: [] },
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    expect((await readdir(markerRoot)).length).toBe(1)
    await h.cleanup()
  })

  test('past resetsAt fires (inactive-window shape 2)', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — claim atomicity', () => {
  test('sanitizes the account id into one marker path component', () => {
    const markerPath = primeMarkerPath(markerRoot, '../escape', 123)
    const resolvedRoot = `${resolve(markerRoot)}${sep}`
    expect(resolve(markerPath).startsWith(resolvedRoot)).toBe(true)
    expect(markerPath).toContain('..%2Fescape-123')
  })

  test('two managers, same marker dir + reset epoch → exactly one fires', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const fresh: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(now - 1000).toISOString(),
        checkedAt: 1,
      },
    }
    const a = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    const b = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    await Promise.all([a.manager.tick(), b.manager.tick()])
    const total = a.sendCalls.length + b.sendCalls.length
    expect(total).toBe(1)
    expect((await readdir(markerRoot)).length).toBe(1)
    await a.cleanup()
    await b.cleanup()
  })

  test('two bootstrap managers fire exactly once via the stable marker', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: 1,
        },
      },
    })
    const now = 7_234_567
    const fresh: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: 2,
      },
    }
    const a = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    const b = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: now + 1_000,
      quotaFresh: fresh,
    })

    await Promise.all([a.manager.tick(), b.manager.tick()])

    expect(a.sendCalls.length + b.sendCalls.length).toBe(1)
    expect(await readdir(a.markerDir)).toEqual(['main-bootstrap'])
    await a.cleanup()
    await b.cleanup()
  })
})

describe('PrimeManager — eligibility', () => {
  test('stored Haiku-scoped exhaustion remains eligible for an authoritative refresh', () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
      killswitch: {
        enabled: true,
        main: { five_hour: 5, seven_day: 10, scoped: 0 },
      },
    }

    expect(
      primeIsEligible({
        storage,
        accountId: 'main',
        isOAuth: true,
        isEnabled: true,
        hasPermanentRefreshError: false,
        quota: {
          five_hour: {
            usedPercent: 20,
            remainingPercent: 80,
            checkedAt: 1,
          },
          seven_day: {
            usedPercent: 30,
            remainingPercent: 70,
            checkedAt: 1,
          },
          scoped: [
            {
              id: 'haiku-weekly',
              title: 'Haiku only',
              modelId: CLAUDE_HAIKU_4_5_MODEL_ID,
              modelName: 'Claude Haiku 4.5',
              usedPercent: 100,
              remainingPercent: 0,
              checkedAt: 1,
            },
          ],
        },
      }),
    ).toEqual({ eligible: true })
  })

  test('disabled fallback is skipped', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(10_000_000).toISOString(),
          checkedAt: 1,
        },
      },
      fallbackType: 'oauth',
      fallbackEnabled: false,
      fallbackQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    expect(fixture.storage.accounts).toHaveLength(1)
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('reserved fallback id main is skipped instead of routing as synthetic main', async () => {
    const previousLevel = getLogLevel()
    setLogLevel('debug')
    setLogLevelSource('debug')
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(10_000_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    fixture.storage.accounts.push({
      id: 'main',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 2,
        },
      },
    })

    await h.manager.tick()

    expect(h.refreshCalls).toEqual([])
    expect(h.sendCalls).toEqual([])
    expect(
      capturedPrimeSink.some(
        (record) =>
          record.channel === 'prime' &&
          record.message === 'ineligible' &&
          record.payload?.reason === 'reserved-id',
      ),
    ).toBe(true)
    setLogLevel(previousLevel)
    setLogLevelSource(previousLevel)
    await h.cleanup()
  })

  test('api-key fallback is skipped', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(10_000_000).toISOString(),
          checkedAt: 1,
        },
      },
      fallbackType: 'api',
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 1_000_000,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(0).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('permanent refresh error → skipped', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(10_000_000).toISOString(),
          checkedAt: 1,
        },
      },
      fallbackPermanent: true,
      fallbackQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('killswitched account is skipped (no modelId)', async () => {
    const fixture = makePrimeFixture({
      killswitch: { enabled: true, main: { five_hour: 5 } },
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })
})

describe('PrimeManager — main + fallbacks evaluated independently', () => {
  test('due fallback fires even when main is not due', async () => {
    const mainFresh = new Date(1_000_000).toISOString()
    const fbFresh = new Date(500).toISOString()
    const fixture = makePrimeFixture({
      fallbackType: 'oauth',
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: mainFresh,
          checkedAt: 1,
        },
      },
      fallbackQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: fbFresh,
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls.map((c) => c.accountId)).toEqual(['work-alt'])
    await h.cleanup()
  })
})

describe('PrimeManager — catch-up', () => {
  test('overdue reset fires on first explicit tick', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 10 * 60_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls.map((c) => c.accountId)).toEqual(['main'])
    expect(h.recordSuccessCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — refresh failure', () => {
  test('refresh failure consumes no marker; retry resumes after the throttle window', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    let now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: { five_hour: undefined },
      refreshError: new Error('boom'),
    })
    h.manager.options.now = () => now
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    h.refreshCalls.length = 0
    const refreshed: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(now - 1000).toISOString(),
        checkedAt: 1,
      },
    }
    h.manager.options.refreshQuota = async () => ({
      quota: refreshed,
      fresh: true,
    })
    now += PRIME_CHECK_THROTTLE_MS
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — send failure', () => {
  test('send failure: marker kept, lastResult=error, no retry this cycle', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      send: () => ({ ok: false, error: 'boom', status: 500 }),
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    expect(h.recordSuccessCalls).toHaveLength(0)
    expect((await readdir(markerRoot)).length).toBe(1)
    const stats = h.manager.stats()
    expect(stats[0]?.lastResult).toBe('error')
    h.sendCalls.length = 0
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })
})

describe('PrimeManager — recordSuccess', () => {
  test('successful send calls recordSuccess once; stats reflect cumulative counters', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      recordSuccessReturn: {
        count: 12,
        inputTokens: 240,
        outputTokens: 12,
        since: 1,
      },
    })
    await h.manager.tick()
    expect(h.recordSuccessCalls).toHaveLength(1)
    expect(h.recordSuccessCalls[0]?.accountId).toBe('main')
    const stats = h.manager.stats()
    expect(stats[0]?.usage?.count).toBe(12)
    expect(stats[0]?.lastResult).toBe('ok')
    expect(stats[0]?.estimatedCostUsd).toBeCloseTo(
      (240 * CLAUDE_HAIKU_4_5_PRICING.input +
        12 * CLAUDE_HAIKU_4_5_PRICING.output) /
        1_000_000,
      9,
    )
    await h.cleanup()
  })

  test('successful fire schedules one quota refresh after 90 seconds', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let scheduled: (() => void) | undefined
    let scheduledDelay: number | undefined
    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
      scheduled = handler
      scheduledDelay = delay
      return 42
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1_000).toISOString(),
          checkedAt: 2,
        },
      },
    })

    try {
      await h.manager.tick()
      expect(h.refreshCalls).toEqual(['main'])
      expect(scheduledDelay).toBe(PRIME_POST_FIRE_REFRESH_MS)

      scheduled?.()
      await Promise.resolve()

      expect(h.refreshCalls).toEqual(['main', 'main'])
      await h.cleanup()
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  test('post-fire refresh skips when another process disables prime', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let scheduled: (() => void) | undefined
    globalThis.setTimeout = ((handler: () => void) => {
      scheduled = handler
      return 42
    }) as typeof setTimeout
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1_000).toISOString(),
          checkedAt: 2,
        },
      },
    })

    try {
      await h.manager.tick()
      expect(h.refreshCalls).toEqual(['main'])
      fixture.storage.prime = { enabled: false }

      scheduled?.()
      await Promise.resolve()
      await Promise.resolve()

      expect(h.refreshCalls).toEqual(['main'])
      await h.cleanup()
    } finally {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })
})

describe('PrimeManager — marker sweep', () => {
  test('markers older than six hours are removed; fresh markers survive', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_100_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 1_000_000_000,
      quotaFresh: {},
    })
    await mkdir(h.markerDir, { recursive: true })
    const oldMarker = join(h.markerDir, 'main-100000')
    await writeFile(oldMarker, '', 'utf8')
    const oldBootstrapMarker = join(h.markerDir, 'main-bootstrap')
    await writeFile(oldBootstrapMarker, '', 'utf8')
    const oldTime = new Date(0)
    await utimes(oldMarker, oldTime, oldTime)
    await utimes(oldBootstrapMarker, oldTime, oldTime)

    const freshMarker = join(h.markerDir, 'main-200000')
    await writeFile(freshMarker, '', 'utf8')

    await h.manager.tick()
    const remaining = (await readdir(h.markerDir)).sort()
    expect(remaining).toContain('main-200000')
    expect(remaining).not.toContain('main-100000')
    expect(remaining).not.toContain('main-bootstrap')
    await h.cleanup()
  })
})

describe('PrimeManager — lifecycle', () => {
  test('start is idempotent; stop is idempotent', async () => {
    const fixture = makePrimeFixture({})
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 1,
      quotaFresh: {},
    })
    h.manager.start()
    h.manager.start()
    h.manager.start()
    h.manager.stop()
    h.manager.stop()
    await h.cleanup()
  })

  test('a tick already in flight aborts before claim when stop() is called', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    // Block refreshQuota until we call stop() so the manager is mid-tick.
    let releaseRefresh: (() => void) | undefined
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    // Override the refresh adapter to block on the gate.
    h.manager.options.refreshQuota = async () => {
      await refreshBlocked
      return {
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now - 1000).toISOString(),
            checkedAt: 1,
          },
        },
        fresh: true,
      }
    }
    const tickPromise = h.manager.tick()
    // Let the tick reach the refresh await.
    await Bun.sleep(10)
    h.manager.stop()
    releaseRefresh!()
    await tickPromise
    // No claim should have been written because the post-refresh stop
    // check aborted the cycle.
    const remaining = await readdir(markerRoot)
    expect(remaining).toEqual([])
    await h.cleanup()
  })

  test('stop cancels the pending post-fire quota refresh', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let scheduled: (() => void) | undefined
    const cleared: unknown[] = []
    globalThis.setTimeout = ((handler: () => void) => {
      scheduled = handler
      return 42
    }) as typeof setTimeout
    globalThis.clearTimeout = ((timer: unknown) => {
      cleared.push(timer)
    }) as typeof clearTimeout
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1_000).toISOString(),
          checkedAt: 2,
        },
      },
    })

    try {
      await h.manager.tick()
      h.manager.stop()
      scheduled?.()
      await Promise.resolve()

      expect(cleared).toEqual([42])
      expect(h.refreshCalls).toEqual(['main'])
    } finally {
      await h.cleanup()
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })
})

describe('PrimeManager — opt-in toggle', () => {
  test('a tick after `prime.enabled=false` does not fire even if due', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    // Disable the feature in stored state.
    fixture.storage.prime = { enabled: false }
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    await h.cleanup()
  })

  test('a tick that re-reads storage after refresh sees a fresh opt-in toggle', async () => {
    // Fixture is initially enabled, but the loadStorage adapter flips to
    // disabled after the refresh await — simulating an `/claude-prime off`
    // racing with an in-flight tick. The post-refresh opt-in check must
    // abort the cycle before claim.
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    let storageDisabled = false
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    h.manager.options.loadStorage = async () => {
      if (storageDisabled) {
        return { ...fixture.storage, prime: { enabled: false } }
      }
      return fixture.storage
    }
    h.manager.options.refreshQuota = async () => {
      storageDisabled = true
      return {
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now - 1000).toISOString(),
            checkedAt: 1,
          },
        },
        fresh: true,
      }
    }
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    await h.cleanup()
  })
})

describe('PrimeManager — fresh-check staleness', () => {
  test('a stale fresh-check (quota API in 429-backoff) skips without claiming', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      // Stored quota has a past resetsAt (so due). The fresh adapter
      // returns a CACHED past resetsAt — i.e. the quota API was in 429
      // backoff and the adapter just returned the cached value with
      // `fresh: false`. Without the staleness guard a stale past resetsAt
      // would let the manager claim+fire against an already-started
      // window.
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
      quotaFreshIsStale: true,
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    // `prime fired` must NOT appear — the skip is a fresh-check skip, not
    // a successful prime.
    const fired = capturedPrimeSink.filter(
      (r) => r.channel === 'prime' && r.message === 'prime fired',
    )
    expect(fired).toHaveLength(0)
    await h.cleanup()
  })
})

describe('PrimeManager — fresh killswitch policy', () => {
  const scopedQuota = (remainingPercent: number): OAuthQuotaSnapshot => ({
    five_hour: {
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: new Date(500).toISOString(),
      checkedAt: 1,
    },
    seven_day: {
      usedPercent: 0,
      remainingPercent: 100,
      checkedAt: 1,
    },
    scoped: [
      {
        id: 'haiku-weekly',
        title: 'Claude Haiku 4.5',
        modelId: CLAUDE_HAIKU_4_5_MODEL_ID,
        modelName: 'Claude Haiku 4.5',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt: 1,
      },
    ],
  })

  test('stored healthy but fresh Haiku-exhausted skips without claiming', async () => {
    const fixture = makePrimeFixture({
      mainQuota: scopedQuota(100),
      killswitch: {
        enabled: true,
        main: { five_hour: 5, seven_day: 10, scoped: 0 },
      },
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 500 + 120_000,
      quotaFresh: scopedQuota(0),
    })

    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls).toEqual([])
    expect(await readdir(markerRoot)).toEqual([])
    await h.cleanup()
  })

  test('stored Haiku-exhausted but fresh healthy after reset fires', async () => {
    const fixture = makePrimeFixture({
      mainQuota: scopedQuota(0),
      killswitch: {
        enabled: true,
        main: { five_hour: 5, seven_day: 10, scoped: 0 },
      },
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 500 + 120_000,
      quotaFresh: scopedQuota(100),
    })

    await h.manager.tick()

    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls.map((call) => call.accountId)).toEqual(['main'])
    await h.cleanup()
  })
})

describe('PrimeManager — post-claim abort', () => {
  test('releases its marker and retries after the throttle window', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    let now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 2,
        },
      },
    })
    h.manager.options.now = () => now
    let loadCount = 0
    h.manager.options.loadStorage = async () => {
      loadCount += 1
      if (loadCount === 3) {
        return { ...fixture.storage, prime: { enabled: false } }
      }
      return fixture.storage
    }

    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect(await readdir(h.markerDir)).toEqual([])

    now += PRIME_CHECK_THROTTLE_MS
    await h.manager.tick()
    expect(h.sendCalls.map((call) => call.accountId)).toEqual(['main'])
    await h.cleanup()
  })
})

describe('PrimeManager — fresh-check skip does not record as primed', () => {
  test('window-active observation does not touch lastPrimedAt/lastResult', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      // Fresh quota has a future resetsAt (window already running).
      quotaFresh: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: new Date(now + 5 * 60_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    const stats = h.manager.stats(fixture.storage, now)
    const mainStatus = stats.find((s) => s.id === 'main') as
      | { lastPrimedAt?: number | null; lastResult?: 'ok' | 'error' }
      | undefined
    // lastPrimedAt / lastResult must NOT be set on a fresh-check skip.
    // Otherwise the status would render "primed HH:MM ✓" for a request
    // that never fired.
    expect(mainStatus?.lastPrimedAt == null).toBe(true)
    expect(mainStatus?.lastResult).toBeUndefined()
    // `isWindowActive` exposes the observation separately so the
    // status / sidebar can render "— window active" without conflating
    // it with a successful prime.
    expect(h.manager.isWindowActive('main')).toBe(true)
    await h.cleanup()
  })
})

describe('PrimeManager — logging', () => {
  test('token-refresh failure logs `prime token refresh failed` (warn) — distinct from the generic `prime fire failed`', async () => {
    const previousLevel = getLogLevel()
    setLogLevel('warn')
    setLogLevelSource('warn')
    // Only work-alt is due, so the assertion remains unambiguous: exactly one
    // `prime token refresh failed` record for the single fire path.
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(10_000_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    fixture.storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      send: () => ({
        ok: false,
        reason: 'token-refresh',
        error: 'main refresh failed',
      }),
    })
    await h.manager.tick()

    const tokenRefreshWarns = capturedPrimeSink.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime token refresh failed',
    )
    expect(tokenRefreshWarns).toHaveLength(1)
    const payload = tokenRefreshWarns[0]?.payload as
      | { account?: string; error?: string }
      | undefined
    expect(payload?.account).toBe('work-alt')
    expect(payload?.error).toBe('main refresh failed')

    // The generic `prime fire failed` must NOT fire for a token-refresh
    // failure — the two events are distinct in the spec Logging table.
    const fireFailedWarns = capturedPrimeSink.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime fire failed',
    )
    expect(fireFailedWarns).toHaveLength(0)
    await h.cleanup()
    setLogLevel(previousLevel)
    setLogLevelSource(previousLevel)
  })

  test('fire success emits info prime record; failure emits warn; skips emit debug/trace; payloads exclude secrets', async () => {
    const previousLevel = getLogLevel()
    setLogLevel('trace')
    setLogLevelSource('trace')
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    fixture.storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const futureReset = 500 + 5 * 60_000
    // A second fallback whose reset is in the future — eligible, but not yet
    // due, so the manager emits a trace skip record (covers the trace branch
    // of the canonical log table).
    fixture.storage.accounts.push({
      id: 'work-future',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(futureReset).toISOString(),
          checkedAt: 1,
        },
      },
    })
    // An API-key account — surfaces the `not-oauth` debug eligibility skip.
    fixture.storage.accounts.push({
      id: 'apikey-acc',
      type: 'api',
      baseURL: 'https://example.com',
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      send: (id) => {
        if (id === 'work-alt') {
          return { ok: false, error: 'fire_failure', status: 500 }
        }
        return {
          ok: true,
          status: 200,
          ms: 1,
          usage: { inputTokens: 20, outputTokens: 1 },
        }
      },
    })
    await h.manager.tick()
    const prime = (m: string) =>
      capturedPrimeSink.filter((r) => r.channel === 'prime' && r.message === m)
    const pick = (
      records: LogTestRecord[],
      account: string,
    ): Record<string, unknown> | undefined => {
      for (const r of records) {
        const accountValue = (r.payload as { account?: unknown })?.account
        if (accountValue === account) {
          return r.payload as Record<string, unknown>
        }
      }
      return undefined
    }

    // -- main: fire success → info, label, status, ms, usage (nested object) --
    const fired = prime('prime fired')
    expect(fired).toHaveLength(1)
    const mainFire = pick(fired, 'main') as
      | {
          account: string
          status: number
          ms: number
          usage: { inputTokens: number; outputTokens: number }
        }
      | undefined
    expect(mainFire).toBeDefined()
    expect(mainFire?.status).toBe(200)
    expect(typeof mainFire?.ms).toBe('number')
    expect(mainFire?.usage).toBeDefined()
    expect(mainFire?.usage?.inputTokens).toBe(20)
    expect(mainFire?.usage?.outputTokens).toBe(1)

    // -- work-alt: fire failed → warn, label, status, error --
    const failed = prime('prime fire failed')
    expect(failed).toHaveLength(1)
    const fbFail = pick(failed, 'work-alt') as
      | { account: string; status?: number; error: string }
      | undefined
    expect(fbFail).toBeDefined()
    expect(fbFail?.status).toBe(500)
    expect(fbFail?.error).toBe('fire_failure')

    // -- apikey-acc: eligibility skip → debug, label, reason --
    const ineligible = prime('ineligible')
    expect(ineligible.length).toBeGreaterThanOrEqual(1)
    const apiSkip = pick(ineligible, 'apikey-acc') as
      | { account: string; reason: string }
      | undefined
    expect(apiSkip).toBeDefined()
    expect(apiSkip?.reason).toBe('API-key account')

    // -- work-future: not due → trace, label --
    const notDue = prime('not due')
    expect(notDue).toHaveLength(1)
    const futureSkip = pick(notDue, 'work-future') as
      | { account: string }
      | undefined
    expect(futureSkip).toBeDefined()

    // -- Lifecycle: manager started → trace, manager stopped → trace --
    h.manager.start()
    expect(
      capturedPrimeSink.some(
        (r) => r.channel === 'prime' && r.message === 'manager started',
      ),
    ).toBe(true)
    h.manager.stop()
    expect(
      capturedPrimeSink.some(
        (r) => r.channel === 'prime' && r.message === 'manager stopped',
      ),
    ).toBe(true)

    // No secret strings in any captured record.
    const serialized = JSON.stringify(capturedPrimeSink)
    expect(serialized).not.toContain('sk-ant-')
    expect(serialized).not.toContain('Bearer ')
    expect(serialized).not.toContain('eyJ')
    setLogLevel(previousLevel)
    setLogLevelSource(previousLevel)
    await h.cleanup()
  })
})
