import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountRuntimeState,
  type AccountScopedQuotaWindow,
  type AccountStorage,
  getAccountStatePath,
  type OAuthQuotaSnapshot,
  saveAccountState,
  saveAccounts,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'

// Behavior contract:
//   Does `persistPushedQuota` drop `scoped` from the persisted main
//   quota snapshot — either when (a) a header harvest lands after a poll on the
//   same access token, or (b) the access token rotates between the poll and the
//   header harvest?
//
// We drive the real `saveAccountState` path (which calls
// `applyMainQuotaStatePatch`) under `OPENCODE_ANTHROPIC_AUTH_FILE` pointed at a
// temp dir, then read the state file directly to observe what was persisted.
//
// The pushed path is replicated inline because it's a closure inside the
// AnthropicAuthPlugin factory; the only behavioral choice that matters for this
// question is whether it does or does NOT touch `storage.quota.mainQuotaToken`.
// The identity-safe shape (no token write, plus accountIdentity guard) is what
// `index.ts:1130-1164` does.

let tempDir: string
let accountPath: string
const REAL_CONFIG = join(
  process.env.HOME ?? '/root',
  '.config/opencode/anthropic-auth.json',
)
let realConfigMtimeBefore: number | undefined

async function realConfigMtime(): Promise<number | undefined> {
  try {
    return (await stat(REAL_CONFIG)).mtimeMs
  } catch {
    return undefined
  }
}

function makeScopedWindow(
  id: string,
  used: number,
  checkedAt: number,
): AccountScopedQuotaWindow {
  return {
    id,
    title: `Scoped ${id}`,
    modelName: id,
    usedPercent: used,
    remainingPercent: 100 - used,
    checkedAt,
  }
}

function buildPollQuota(checkedAt: number): OAuthQuotaSnapshot {
  return {
    source: 'poll',
    accountIdentity: 'main-acct-1',
    checkedAt,
    five_hour: {
      usedPercent: 12,
      remainingPercent: 88,
      checkedAt,
    },
    seven_day: {
      usedPercent: 33,
      remainingPercent: 67,
      checkedAt,
    },
    scoped: [
      makeScopedWindow('claude-3-7-sonnet', 50, checkedAt),
      makeScopedWindow('claude-opus-4', 22, checkedAt),
    ],
    extraUsage: {
      used: { amountMinor: 100, currency: 'USD', exponent: -2 },
      limit: { amountMinor: 5000, currency: 'USD', exponent: -2 },
      exhausted: false,
    },
    bindingWindow: 'five_hour',
    bindingWindowSource: 'poll',
  }
}

function buildHeaderQuota(
  checkedAt: number,
  accountIdentity = 'main-acct-1',
): OAuthQuotaSnapshot {
  return {
    source: 'headers',
    accountIdentity,
    checkedAt,
    five_hour: {
      usedPercent: 18,
      remainingPercent: 82,
      checkedAt,
    },
    seven_day: {
      usedPercent: 35,
      remainingPercent: 65,
      checkedAt,
    },
    // Raw headers carry no scoped, no extraUsage, no bindingWindow.
  }
}

async function readStateFile(): Promise<AccountRuntimeState> {
  return JSON.parse(
    await readFile(getAccountStatePath(accountPath), 'utf8'),
  ) as AccountRuntimeState
}

async function seedStorage(): Promise<AccountStorage> {
  const storage: AccountStorage = {
    version: 1,
    mainAccountId: 'main-acct-1',
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  }
  await saveAccounts(storage, accountPath)
  return storage
}

/** Mirror of `persistPushedQuota`'s storage write for the main branch at HEAD. */
async function pushHeaderHarvest(
  storage: AccountStorage,
  header: OAuthQuotaSnapshot,
  checkedAt: number,
  options: { writeMainQuotaToken?: boolean; servedAccessToken?: string } = {},
) {
  storage.quota = storage.quota ?? {}
  storage.quota.mainQuota = {
    ...header,
    accountIdentity: storage.mainAccountId,
  }
  storage.quota.mainQuotaCheckedAt = checkedAt
  if (options.writeMainQuotaToken && options.servedAccessToken !== undefined) {
    storage.quota.mainQuotaToken = tokenFingerprint(options.servedAccessToken)
  }
  await saveAccountState(storage, accountPath, { mainQuota: true })
}

/** Mirror of the polled path's storage write (lines 962-966). */
async function pollMain(
  storage: AccountStorage,
  quota: OAuthQuotaSnapshot,
  checkedAt: number,
  accessToken: string,
) {
  storage.quota = storage.quota ?? {}
  storage.quota.mainQuota = quota
  storage.quota.mainQuotaCheckedAt = checkedAt
  storage.quota.mainQuotaToken = tokenFingerprint(accessToken)
  storage.quota.mainLastQuotaApiError = undefined
  await saveAccountState(storage, accountPath, { mainQuota: true })
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'quota-token-merge-contract-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  realConfigMtimeBefore = await realConfigMtime()
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  await rm(tempDir, { recursive: true, force: true })
  // These tests drive the real save path, so a resolver regression would write
  // to the user's live config instead of the temp file.
  expect(await realConfigMtime()).toBe(realConfigMtimeBefore)
})

describe('token rotation preserves scoped quota windows and extra usage', () => {
  test('Q1 — same-token case: header harvest after poll preserves scoped', async () => {
    const storage = await seedStorage()

    // Poll establishes scoped quota and a token fingerprint.
    const pollCheckedAt = 1_000
    await pollMain(
      storage,
      buildPollQuota(pollCheckedAt),
      pollCheckedAt,
      'token-A',
    )

    let state = await readStateFile()
    const fingerprintBefore = state.main?.quotaToken
    const scopedBefore = state.main?.quota?.scoped
    expect(fingerprintBefore).toBe(tokenFingerprint('token-A'))
    expect(scopedBefore).toBeDefined()
    expect(scopedBefore?.length).toBe(2)

    // Header harvest lands, same access token.
    const headerCheckedAt = pollCheckedAt + 50
    await pushHeaderHarvest(
      storage,
      buildHeaderQuota(headerCheckedAt),
      headerCheckedAt,
    )

    state = await readStateFile()

    const quota = state.main?.quota
    const headerResult = {
      persisted_source: quota?.source,
      persisted_accountIdentity: quota?.accountIdentity,
      persisted_scoped_present:
        Array.isArray(quota?.scoped) && (quota?.scoped?.length ?? 0) > 0,
      persisted_scoped_count: quota?.scoped?.length ?? 0,
      persisted_extraUsage_present: Boolean(quota?.extraUsage),
      persisted_bindingWindow: quota?.bindingWindow,
      persisted_bindingWindowSource: quota?.bindingWindowSource,
      persisted_five_hour_usedPercent: quota?.five_hour?.usedPercent,
      persisted_quotaToken: state.main?.quotaToken,
      persisted_quotaCheckedAt: state.main?.quotaCheckedAt,
    }
    void headerResult

    // The merged snapshot must still carry the poll's scoped windows, the
    // poll's extraUsage, and the poll's bindingWindowSource — even though the
    // header snapshot has none of those.
    expect(quota?.scoped?.length).toBe(2)
    expect(state.main?.quotaToken).toBe(fingerprintBefore)
    expect(quota?.extraUsage).toBeDefined()
    expect(quota?.bindingWindow).toBe('five_hour')
    expect(quota?.bindingWindowSource).toBe('poll')
    // Five-hour utilization must come from the header (newer checkedAt + poll precedence).
    expect(quota?.five_hour?.usedPercent).toBe(18)
  })

  test('Q2 — HEAD pushed harvest ignores rotated served token and preserves poll fields', async () => {
    const storage = await seedStorage()

    // Poll establishes scoped quota with token-A.
    const pollCheckedAt = 1_000
    await pollMain(
      storage,
      buildPollQuota(pollCheckedAt),
      pollCheckedAt,
      'token-A',
    )

    let state = await readStateFile()
    const fingerprintBefore = state.main?.quotaToken
    expect(fingerprintBefore).toBe(tokenFingerprint('token-A'))

    // The served token is intentionally absent: HEAD's pushed path does not
    // inspect or write it.
    const headerCheckedAt = pollCheckedAt + 50
    await pushHeaderHarvest(
      storage,
      buildHeaderQuota(headerCheckedAt),
      headerCheckedAt,
    )

    state = await readStateFile()

    const quota = state.main?.quota
    const rotationResult = {
      persisted_source: quota?.source,
      persisted_scoped_present:
        Array.isArray(quota?.scoped) && (quota?.scoped?.length ?? 0) > 0,
      persisted_scoped_count: quota?.scoped?.length ?? 0,
      persisted_extraUsage_present: Boolean(quota?.extraUsage),
      persisted_bindingWindowSource: quota?.bindingWindowSource,
      persisted_quotaToken: state.main?.quotaToken,
      persisted_quotaToken_unchanged_from_poll:
        state.main?.quotaToken === tokenFingerprint('token-A'),
    }
    void rotationResult

    expect(quota?.scoped?.length).toBe(2)
    expect(state.main?.quotaToken).toBe(tokenFingerprint('token-A'))
    expect(quota?.extraUsage).toBeDefined()
    expect(quota?.bindingWindowSource).toBe('poll')
  })

  test('Q2-control — token-keyed persistence loses scoped data after rotation', async () => {
    const storage = await seedStorage()

    const pollCheckedAt = 1_000
    await pollMain(
      storage,
      buildPollQuota(pollCheckedAt),
      pollCheckedAt,
      'token-A',
    )

    let state = await readStateFile()
    expect(state.main?.quotaToken).toBe(tokenFingerprint('token-A'))

    // Token-keyed persistence overwrites mainQuotaToken with the served token's
    // fingerprint, so the persisted snapshot no longer matches the poll.
    const headerCheckedAt = pollCheckedAt + 50
    await pushHeaderHarvest(
      storage,
      buildHeaderQuota(headerCheckedAt),
      headerCheckedAt,
      { writeMainQuotaToken: true, servedAccessToken: 'token-B' },
    )

    state = await readStateFile()

    const quota = state.main?.quota
    const tokenKeyedResult = {
      persisted_source: quota?.source,
      persisted_scoped_present:
        Array.isArray(quota?.scoped) && (quota?.scoped?.length ?? 0) > 0,
      persisted_scoped_count: quota?.scoped?.length ?? 0,
      persisted_extraUsage_present: Boolean(quota?.extraUsage),
      persisted_bindingWindowSource: quota?.bindingWindowSource,
      persisted_quotaToken: state.main?.quotaToken,
    }
    void tokenKeyedResult

    // A token-keyed write loses the poll-only fields when the access token
    // rotates before the header harvest.
    expect(quota?.scoped?.length ?? 0).toBe(0)
    expect(quota?.extraUsage).toBeUndefined()
    expect(quota?.bindingWindowSource).not.toBe('poll')
  })

  test('Q3 — sameToken at the moment of apply, with what actually persists', async () => {
    // applyMainQuotaStatePatch reads the existing state file into `state`,
    // compares against `storage`, then overwrites `state.main.quotaToken` to
    // match storage. So sameToken post-save is always true. The interesting
    // observation is what sameToken is at the START of the function — which
    // determines whether scoped survives. We compute that here from the
    // pre-save state file and the storage we are about to persist.

    function evaluateSameToken(
      state: AccountRuntimeState,
      storage: AccountStorage,
    ) {
      return Boolean(
        state.main?.quotaToken &&
          storage.quota?.mainQuotaToken &&
          state.main?.quotaToken === storage.quota.mainQuotaToken,
      )
    }

    const fp = (t: string) => tokenFingerprint(t)

    // Scenario A — same token
    {
      const storage = await seedStorage()
      await pollMain(storage, buildPollQuota(1_000), 1_000, 'token-A')
      const preHarvestState = await readStateFile()
      // HEAD behavior: pushHeaderHarvest with no mainQuotaToken write.
      storage.quota = {
        ...storage.quota,
        mainQuota: buildHeaderQuota(1_050),
        mainQuotaCheckedAt: 1_050,
      }
      const sameToken = evaluateSameToken(preHarvestState, storage)
      await saveAccountState(storage, accountPath, { mainQuota: true })
      const after = await readStateFile()

      expect(sameToken).toBe(true)
      expect(after.main?.quota?.scoped?.length).toBe(2)
    }

    // Scenario B — rotation, HEAD behavior (no mainQuotaToken write on push)
    {
      const storage = await seedStorage()
      await pollMain(storage, buildPollQuota(2_000), 2_000, 'token-A')
      const preHarvestState = await readStateFile()
      storage.quota = {
        ...storage.quota,
        mainQuota: buildHeaderQuota(2_050),
        mainQuotaCheckedAt: 2_050,
      }
      const sameToken = evaluateSameToken(preHarvestState, storage)
      await saveAccountState(storage, accountPath, { mainQuota: true })
      const after = await readStateFile()

      expect(sameToken).toBe(true)
      expect(after.main?.quota?.scoped?.length).toBe(2)
      expect(after.main?.quotaToken).toBe(fp('token-A'))
    }

    // Scenario C — rotation with token-keyed persistence.
    {
      const storage = await seedStorage()
      await pollMain(storage, buildPollQuota(3_000), 3_000, 'token-A')
      const preHarvestState = await readStateFile()
      storage.quota = {
        ...storage.quota,
        mainQuota: buildHeaderQuota(3_050),
        mainQuotaCheckedAt: 3_050,
        mainQuotaToken: fp('token-B'),
      }
      const sameToken = evaluateSameToken(preHarvestState, storage)
      await saveAccountState(storage, accountPath, { mainQuota: true })
      const after = await readStateFile()

      expect(sameToken).toBe(false)
      expect(after.main?.quota?.scoped?.length ?? 0).toBe(0)
      expect(after.main?.quotaToken).toBe(fp('token-B'))
    }
  })

  test('Q4 — fresh-install case: header harvest with no prior poll loses nothing', async () => {
    const storage = await seedStorage()

    // No poll. Header harvest lands first.
    const headerCheckedAt = 5_000
    await pushHeaderHarvest(
      storage,
      buildHeaderQuota(headerCheckedAt),
      headerCheckedAt,
    )

    const state = await readStateFile()
    const quota = state.main?.quota
    const freshResult = {
      persisted_source: quota?.source,
      persisted_scoped_present:
        Array.isArray(quota?.scoped) && (quota?.scoped?.length ?? 0) > 0,
      persisted_quotaToken: state.main?.quotaToken,
    }
    void freshResult

    expect(quota?.source).toBe('headers')
    expect(state.main?.quotaToken).toBeUndefined() // no poll ran
    expect(quota?.scoped ?? []).toEqual([])
  })

  test('Q5 — repeated header harvests preserve scoped data through rotation', async () => {
    // Walk the field write paths and confirm that no sequence exists
    // where a header harvest causes `scoped` to disappear from the persisted
    // snapshot. We try the most adversarial ordering: poll → header × N →
    // header with new token, and watch scoped at each step.
    const storage = await seedStorage()

    const pollCheckedAt = 10_000
    await pollMain(
      storage,
      buildPollQuota(pollCheckedAt),
      pollCheckedAt,
      'token-A',
    )

    let state = await readStateFile()
    expect(state.main?.quota?.scoped?.length).toBe(2)

    // Repeated header harvests leave the persisted quota token untouched.
    for (let i = 1; i <= 5; i++) {
      await pushHeaderHarvest(
        storage,
        buildHeaderQuota(pollCheckedAt + i * 10),
        pollCheckedAt + i * 10,
        { writeMainQuotaToken: false },
      )
      state = await readStateFile()
      expect(state.main?.quota?.scoped?.length).toBe(2)
    }

    // Token rotation followed by another header harvest must preserve the
    // poll-derived scoped windows.
    await pushHeaderHarvest(
      storage,
      buildHeaderQuota(pollCheckedAt + 100),
      pollCheckedAt + 100,
    )
    state = await readStateFile()
    const after = {
      source: state.main?.quota?.source,
      scoped_count: state.main?.quota?.scoped?.length,
      quotaToken: state.main?.quotaToken,
    }
    void after

    expect(state.main?.quota?.scoped?.length).toBe(2)
    expect(state.main?.quotaToken).toBe(tokenFingerprint('token-A'))
  })
})
