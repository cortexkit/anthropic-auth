import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import { createLiveCustodyDeps } from '../custody-live.ts'
import {
  acquireCustodyTransitionLocks,
  CustodyLockBusyError,
  CustodyPreflightRefusedError,
  CustodyStateMismatchError,
  executeClaustrumTakeover,
  executeLocalExit,
  preflightClaustrumTakeover,
  reconcileCustodyStartup,
} from '../custody-mode.ts'

const now = 1_700_000_000_000
const fixtureTokens = [
  'access-main-secret',
  'refresh-main-secret',
  'vault-secret',
]
const fixtureHandles = ['handle-main', 'handle-work']

function real(access: string, refresh: string) {
  return { type: 'oauth' as const, access, refresh }
}

function route(
  id: string,
  options: { enabled?: boolean; type?: 'oauth' | 'api' } = {},
) {
  return {
    id,
    type: options.type ?? 'oauth',
    enabled: options.enabled ?? true,
    label: id,
    local: real(`access-${id}-secret`, `refresh-${id}-secret`),
  }
}

function preflightInput(overrides: Record<string, unknown> = {}) {
  const calls = { auth: 0, cache: 0, locks: 0, transport: 0 }
  const input = {
    now,
    storage: { refresh: { refreshBeforeExpiryMinutes: 5 } },
    main: { id: 'main', label: 'main', enabled: true },
    fallbacks: [
      route('work'),
      route('disabled', { enabled: false }),
      route('api', { type: 'api' }),
    ],
    hostAuth: {
      get: () => {
        calls.auth++
        return core.custodyTombstoneOAuth('anthropic')
      },
    },
    bindings: [
      {
        accountId: 'main',
        label: 'main',
        handle: 'handle-main',
        credentialId: 'oauth:anthropic:main',
      },
      {
        accountId: 'work',
        label: 'work',
        handle: 'handle-work',
        credentialId: 'oauth:anthropic:work',
      },
    ],
    cache: {
      get: async (handle: string, { minTtlMs }: { minTtlMs: number }) => {
        calls.cache++
        calls.transport++
        return {
          handle,
          credentialId:
            handle === 'handle-main'
              ? 'oauth:anthropic:main'
              : 'oauth:anthropic:work',
          recordVersion: 4,
          access: `vault-secret-${handle}`,
          refresh: `vault-refresh-${handle}`,
          expiresAt: now + minTtlMs + 1,
          state: 'usable' as const,
        }
      },
    },
    acquireLock: async () => {
      calls.locks++
      return { release: async () => {} }
    },
    calls,
    ...overrides,
  }
  return input
}

describe('custody mode', () => {
  test('custody: live adapter maps host auth, loaded manifest, and cache', async () => {
    const get = async () => core.custodyTombstoneOAuth('anthropic')
    const manifestHandle = `ckh_${'A'.repeat(43)}`
    const storage: core.AccountStorage = {
      version: 1,
      accounts: [],
      claustrum: { handlesFile: '/resolved-handles.json' },
      refresh: { refreshBeforeExpiryMinutes: 5 },
    }
    const directory = await mkdtemp(join(tmpdir(), 'custody-live-adapter-'))
    const storagePath = join(directory, 'storage.json')
    const manifestPath = join(directory, 'handles.json')
    const cacheCalls: Array<{ handle: string; minTtlMs?: number }> = []
    try {
      await expect(
        core.writeCustodyHandleManifestEntry({
          path: manifestPath,
          entry: {
            label: 'main',
            handle: manifestHandle,
            credentialId: 'oauth:anthropic:main',
          },
        }),
      ).resolves.toEqual({ status: 'written' })
      await core.saveAccounts(
        {
          ...storage,
          claustrum: { handlesFile: manifestPath },
        },
        storagePath,
      )
      const deps = createLiveCustodyDeps({
        storagePath,
        cache: {
          get: async (handle, minTtlMs) => {
            cacheCalls.push({ handle, minTtlMs })
            return {
              credentialId: 'oauth:anthropic:main',
              recordVersion: 1,
              access: 'vault-access',
              refresh: 'vault-refresh',
              expiresAt: now + (minTtlMs ?? 0) + 1,
              state: 'usable',
            }
          },
        },
        latestGetAuth: get,
        now,
      })

      expect(deps.hostAuth.get).toBe(get)
      expect(deps.hostAuth).not.toHaveProperty('set')
      await deps.readBindings([{ id: 'main', label: 'main', type: 'oauth' }])
      expect(deps.manifestPath).toBe(manifestPath)
      await preflightClaustrumTakeover(
        await deps.preflightInput(
          { id: 'main', label: 'main', enabled: true },
          [],
        ),
      )
      expect(cacheCalls).toEqual([
        {
          handle: manifestHandle,
          minTtlMs: core.getRefreshBeforeExpiryMs(storage) + 30 * 60_000,
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('custody: live adapter keeps non-expiring vault credentials usable', async () => {
    const get = async () => core.custodyTombstoneOAuth('anthropic')
    const manifestHandle = `ckh_${'A'.repeat(43)}`
    const storage: core.AccountStorage = {
      version: 1,
      accounts: [],
      claustrum: { handlesFile: '/resolved-handles.json' },
      refresh: { refreshBeforeExpiryMinutes: 5 },
    }
    const directory = await mkdtemp(join(tmpdir(), 'custody-live-adapter-'))
    const storagePath = join(directory, 'storage.json')
    const manifestPath = join(directory, 'handles.json')
    const debugMessages: string[] = []
    try {
      await expect(
        core.writeCustodyHandleManifestEntry({
          path: manifestPath,
          entry: {
            label: 'main',
            handle: manifestHandle,
            credentialId: 'oauth:anthropic:main',
          },
        }),
      ).resolves.toEqual({ status: 'written' })
      await core.saveAccounts(
        {
          ...storage,
          claustrum: { handlesFile: manifestPath },
        },
        storagePath,
      )
      const deps = createLiveCustodyDeps({
        storagePath,
        cache: {
          get: async (_handle, minTtlMs) => ({
            payload: JSON.stringify({
              access_token: 'vault-access',
              refresh_token: 'vault-refresh',
            }),
            expiresAtMs: null,
            recordVersion: 1,
            accountId: 'vault-account',
          }),
        },
        latestGetAuth: get,
        now,
        debug: (message: string) => debugMessages.push(message),
      })

      const input = await deps.preflightInput(
        { id: 'main', label: 'main', enabled: true },
        [],
      )
      input.bindings[0]!.credentialId = 'oauth:anthropic:x'
      const plan = await preflightClaustrumTakeover(input)
      expect(plan).toMatchObject({ accounts: [{ id: 'main' }] })
      expect(debugMessages).toEqual([
        'custody identity check skipped: vault supplied no credential id',
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('custody: preflight verifies every account before any write', async () => {
    const cases = [
      {
        name: 'missing binding',
        mutate: (input: any) => (input.bindings = input.bindings.slice(0, 1)),
        reason: 'binding_missing',
      },
      {
        name: 'revoked credential',
        mutate: (input: any) =>
          (input.cache.get = async (
            handle: string,
            { minTtlMs }: { minTtlMs: number },
          ) =>
            handle === 'handle-work'
              ? { state: 'revoked' }
              : {
                  credentialId: 'oauth:anthropic:main',
                  recordVersion: 4,
                  access: 'vault-secret-main',
                  refresh: 'vault-refresh-main',
                  expiresAt: now + minTtlMs + 1,
                  state: 'usable',
                }),
        reason: 'credential_revoked',
      },
      {
        name: 'reauth credential',
        mutate: (input: any) =>
          (input.cache.get = async (
            handle: string,
            { minTtlMs }: { minTtlMs: number },
          ) =>
            handle === 'handle-work'
              ? { state: 'reauth' }
              : {
                  credentialId: 'oauth:anthropic:main',
                  recordVersion: 4,
                  access: 'vault-secret-main',
                  refresh: 'vault-refresh-main',
                  expiresAt: now + minTtlMs + 1,
                  state: 'usable',
                }),
        reason: 'credential_reauth',
      },
      {
        name: 'unusable credential',
        mutate: (input: any) =>
          (input.cache.get = async (
            handle: string,
            { minTtlMs }: { minTtlMs: number },
          ) =>
            handle === 'handle-work'
              ? { state: 'usable', expiresAt: now }
              : {
                  credentialId: 'oauth:anthropic:main',
                  recordVersion: 4,
                  access: 'vault-secret-main',
                  refresh: 'vault-refresh-main',
                  expiresAt: now + minTtlMs + 1,
                  state: 'usable',
                }),
        reason: 'credential_unusable',
      },
      {
        name: 'divergence fence',
        mutate: (input: any) =>
          (input.storage.claustrumDivergence = {
            'oauth:anthropic:work': { minimumRecordVersion: 5 },
          }),
        reason: 'divergence_fenced',
      },
      {
        name: 'credential identity mismatch',
        mutate: (input: any) =>
          (input.cache.get = async (
            handle: string,
            { minTtlMs }: { minTtlMs: number },
          ) => ({
            credentialId:
              handle === 'handle-work'
                ? 'oauth:anthropic:other'
                : 'oauth:anthropic:main',
            recordVersion: 4,
            access: `vault-secret-${handle}`,
            refresh: `vault-refresh-${handle}`,
            expiresAt: now + minTtlMs + 1,
            state: 'usable',
          })),
        reason: 'credential_identity_mismatch',
      },
    ]

    for (const entry of cases) {
      const input = preflightInput()
      entry.mutate(input)
      const error = await preflightClaustrumTakeover(input).catch(
        (error: unknown) => error,
      )
      expect(error).toMatchObject({
        code: 'custody_preflight_refused',
        accountId: 'work',
        reason: entry.reason,
      })
      for (const token of [...fixtureTokens, ...fixtureHandles]) {
        expect(String(error), entry.name).not.toContain(token)
        expect(JSON.stringify(error), entry.name).not.toContain(token)
      }
      expect(input.calls.auth, entry.name).toBe(1)
      expect(input.calls.locks, entry.name).toBe(0)
    }

    const input = preflightInput()
    const plan = await preflightClaustrumTakeover(input)
    expect(plan.accounts.map((account) => account.id)).toEqual(['main', 'work'])
    expect(plan.accounts.map((account) => account.handle)).toEqual(
      fixtureHandles,
    )
    expect(input.calls.auth).toBe(1)
    expect(input.calls.cache).toBe(2)
    expect(input.calls.transport).toBe(2)
    expect(input.calls.locks).toBe(0)
    const printable = JSON.stringify(plan)
    for (const token of [...fixtureTokens, ...fixtureHandles])
      expect(printable).not.toContain(token)
  })

  test('custody: fresh install refuses before creating a store', async () => {
    const tombstone = core.custodyTombstoneOAuth('anthropic')
    const fresh = preflightInput({
      storage: null,
      hostAuth: { get: () => tombstone },
    })
    await expect(preflightClaustrumTakeover(fresh)).resolves.toMatchObject({
      accounts: [{ id: 'main' }, { id: 'work' }],
    })
    expect(fresh.calls.transport).toBe(2)
    expect(fresh.calls.locks).toBe(0)

    const emptyStore = preflightInput({ storage: { version: 1 } })
    await expect(preflightClaustrumTakeover(emptyStore)).resolves.toMatchObject(
      {
        accounts: [{ id: 'main' }, { id: 'work' }],
      },
    )
    expect(emptyStore.calls.locks).toBe(0)
  })

  test('custody: preflight refuses a real main until the operator migrates it', async () => {
    const input = preflightInput({
      storage: null,
      hostAuth: {
        get: () => real('access-main-secret', 'refresh-main-secret'),
      },
    })

    await expect(preflightClaustrumTakeover(input)).rejects.toMatchObject({
      code: 'custody_preflight_refused',
      accountId: 'main',
      reason: 'TAKEOVER_INCOMPLETE_MAIN_REAL',
    })
  })

  test('custody: preflight refuses a tombstoned main without its manifest binding', async () => {
    const input = preflightInput({
      hostAuth: { get: () => core.custodyTombstoneOAuth('anthropic') },
      bindings: [
        {
          accountId: 'work',
          label: 'work',
          handle: 'handle-work',
          credentialId: 'oauth:anthropic:work',
        },
      ],
    })

    await expect(preflightClaustrumTakeover(input)).rejects.toMatchObject({
      code: 'custody_preflight_refused',
      accountId: 'main',
      reason: 'TAKEOVER_INCOMPLETE_MAIN_BINDING',
    })
  })

  test('custody: preflight reports every fallback refusal in account order', async () => {
    const input = preflightInput({
      fallbacks: [route('work'), route('personal')],
      bindings: [
        {
          accountId: 'main',
          label: 'main',
          handle: 'handle-main',
          credentialId: 'oauth:anthropic:main',
        },
        {
          accountId: 'work',
          label: 'work',
          handle: 'handle-work',
          credentialId: 'oauth:anthropic:work',
        },
        {
          accountId: 'personal',
          label: 'personal',
          handle: 'handle-personal',
          credentialId: 'oauth:anthropic:personal',
        },
      ],
      cache: {
        get: async (handle: string) =>
          handle === 'handle-work'
            ? { state: 'reauth' }
            : handle === 'handle-personal'
              ? { state: 'timeout' }
              : {
                  credentialId: 'oauth:anthropic:main',
                  recordVersion: 4,
                  access: 'vault-access',
                  refresh: 'vault-refresh',
                  expiresAt: Number.MAX_SAFE_INTEGER,
                  state: 'usable' as const,
                },
      },
    })

    const error = await preflightClaustrumTakeover(input).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(CustodyPreflightRefusedError)
    expect((error as CustodyPreflightRefusedError).toJSON()).toMatchObject({
      ok: false,
      accountId: 'work',
      reason: 'credential_reauth',
      refusals: [
        { label: 'work', reason: 'credential_reauth' },
        { label: 'personal', reason: 'credential_timeout' },
      ],
    })
    const printable = JSON.stringify(error)
    for (const token of [
      ...fixtureTokens,
      ...fixtureHandles,
      'handle-personal',
    ])
      expect(printable).not.toContain(token)
  })

  test('custody: startup matrix verdicts', () => {
    const expected = new Map<string, string>([
      ['L|R|R|V', 'LOCAL_SERVE'],
      ['L|R|R|N', 'LOCAL_SERVE'],
      ['L|R|T|V', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|R|T|N', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|R|M|V', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|R|M|N', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|T|R|V', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|T|R|N', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|T|T|V', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|T|T|N', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|T|M|V', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|T|M|N', 'REMAIN_DARK_PENDING_LOGIN'],
      ['L|X|R|V', 'FAIL_CLOSED'],
      ['L|X|R|N', 'FAIL_CLOSED'],
      ['L|X|T|V', 'FAIL_CLOSED'],
      ['L|X|T|N', 'FAIL_CLOSED'],
      ['L|X|M|V', 'FAIL_CLOSED'],
      ['L|X|M|N', 'FAIL_CLOSED'],
      ['C|R|R|V', 'TAKEOVER_INCOMPLETE_MAIN_REAL'],
      ['C|R|R|N', 'TAKEOVER_INCOMPLETE_VAULT_UNAVAILABLE'],
      ['C|R|T|V', 'TAKEOVER_INCOMPLETE_MAIN_REAL'],
      ['C|R|T|N', 'FAIL_CLOSED'],
      ['C|R|M|V', 'TAKEOVER_INCOMPLETE_MAIN_REAL'],
      ['C|R|M|N', 'FAIL_CLOSED'],
      ['C|T|R|V', 'RESUME_TAKEOVER'],
      ['C|T|R|N', 'FAIL_CLOSED'],
      ['C|T|T|V', 'CLAUSTRUM_SERVE'],
      ['C|T|T|N', 'FAIL_CLOSED'],
      ['C|T|M|V', 'RESUME_TAKEOVER'],
      ['C|T|M|N', 'FAIL_CLOSED'],
      ['C|X|R|V', 'TAKEOVER_INCOMPLETE_SLOT_ABSENT'],
      ['C|X|R|N', 'FAIL_CLOSED'],
      ['C|X|T|V', 'TAKEOVER_INCOMPLETE_SLOT_ABSENT'],
      ['C|X|T|N', 'FAIL_CLOSED'],
      ['C|X|M|V', 'TAKEOVER_INCOMPLETE_SLOT_ABSENT'],
      ['C|X|M|N', 'FAIL_CLOSED'],
    ])
    expect(expected).toHaveLength(36)
    for (const [key, verdict] of expected) {
      const [mode, main, fallbacks, evidence] = key.split('|') as [
        'L' | 'C',
        'R' | 'T' | 'X',
        'R' | 'T' | 'M',
        'V' | 'N',
      ]
      if (verdict === 'LOCAL_SERVE' || verdict === 'CLAUSTRUM_SERVE') {
        expect(
          reconcileCustodyStartup({ mode, main, fallbacks, evidence }),
        ).toMatchObject({ verdict })
      } else {
        expect(() =>
          reconcileCustodyStartup({ mode, main, fallbacks, evidence }),
        ).toThrow(CustodyStateMismatchError)
        try {
          reconcileCustodyStartup({ mode, main, fallbacks, evidence })
        } catch (error) {
          expect(error).toMatchObject({
            code: 'custody_state_mismatch',
            verdict,
            dimensions: { mode, main, fallbacks, evidence },
          })
          expect(JSON.stringify(error)).not.toContain('access-main-secret')
        }
      }
    }
  })

  test('custody: provisional reconcile identifies fallback-driven darkness', () => {
    expect(
      reconcileCustodyStartup({
        mode: 'C',
        mainSlot: 'unknown',
        fallbacks: 'T',
        evidence: 'N',
      }),
    ).toEqual({ verdict: 'FAIL_CLOSED', provisional: true })
    expect(
      reconcileCustodyStartup({
        mode: 'C',
        mainSlot: 'unknown',
        fallbacks: 'T',
        evidence: 'unknown',
      }),
    ).toEqual({ verdict: 'PENDING_MAIN_SLOT', provisional: true })
  })

  test('custody: locks acquire in total order and unwind on contention', async () => {
    const order: string[] = []
    const released: string[] = []
    await expect(
      acquireCustodyTransitionLocks({
        storagePath: '/storage.json',
        manifestPath: '/handles.json',
        fallbackAccountIds: ['zulu', 'alpha'],
        acquireTransition: async () => ({
          release: async () => {
            released.push('transition')
          },
        }),
        acquireManifest: async () => ({
          release: async () => {
            released.push('manifest')
          },
        }),
        acquireRefresh: async ({ name }: { name: string }) => {
          order.push(name)
          if (name === 'alpha-refresh') return null
          return {
            release: async () => {
              released.push(name)
            },
          }
        },
      }),
    ).rejects.toBeInstanceOf(CustodyLockBusyError)
    expect(order).toEqual(['opencode-main-oauth-refresh', 'alpha-refresh'])
    expect(released).toEqual([
      'opencode-main-oauth-refresh',
      'manifest',
      'transition',
    ])
  })

  test('custody: takeover restores raw sidecars when a staged write fails', async () => {
    const plan = await preflightClaustrumTakeover(preflightInput())
    const before = {
      config: new TextEncoder().encode('{"accounts":["before"]}\n'),
      state: new TextEncoder().encode('{"state":"before"}\n'),
    }
    let config = before.config.slice()
    let state = before.state.slice()
    let mode = 'local'
    const writes: string[] = []

    const error = await executeClaustrumTakeover(plan, {
      locks: {
        storagePath: '/storage.json',
        manifestPath: '/handles.json',
        fallbackAccountIds: ['work'],
        acquireTransition: async () => ({ release: async () => {} }),
        acquireManifest: async () => ({ release: async () => {} }),
        acquireRefresh: async () => ({ release: async () => {} }),
      },
      getLocalAuth: async (accountId) =>
        accountId === 'main'
          ? core.custodyTombstoneOAuth('anthropic')
          : real('access-work-secret', 'refresh-work-secret'),
      isCommitted: async () => false,
      snapshotSidecars: async () => ({
        config: config.slice(),
        state: state.slice(),
      }),
      writeManifestBindings: async () => {},
      writeSidecarAccount: async (account) => {
        writes.push(account.id)
        config = new TextEncoder().encode(`{"bound":"${account.id}"}\n`)
        if (account.id === 'work') throw new Error('disk full')
        state = new TextEncoder().encode(`{"inert":"${account.id}"}\n`)
      },
      verifyTarget: async () => true,
      verifyCommitted: async () => true,
      restoreSidecars: async (snapshot) => {
        config = snapshot.config!.slice()
        state = snapshot.state!.slice()
      },
      verifyRollback: async () =>
        JSON.stringify(config) === JSON.stringify(before.config) &&
        JSON.stringify(state) === JSON.stringify(before.state),
      setMode: async (target) => {
        mode = target
        return 'changed'
      },
    }).catch((error: unknown) => error)

    expect(error).toMatchObject({
      code: 'custody_transition_failed',
      stage: 'write_sidecar',
      accountId: 'work',
    })
    expect(writes).toEqual(['work'])
    expect(config).toEqual(before.config)
    expect(state).toEqual(before.state)
    expect(mode).toBe('local')
    expect(JSON.stringify(error)).not.toContain('access-work-secret')
  })

  test('custody: failed committed readback reverts mode before restoring sidecars', async () => {
    const plan = await preflightClaustrumTakeover(preflightInput())
    const before = {
      config: new TextEncoder().encode('{"access":"access-work-secret"}\n'),
      state: new TextEncoder().encode('{"refresh":"refresh-work-secret"}\n'),
    }
    let config = before.config.slice()
    let state = before.state.slice()
    let mode: 'local' | 'claustrum' = 'local'

    const error = await executeClaustrumTakeover(plan, {
      locks: {
        storagePath: '/storage.json',
        manifestPath: '/handles.json',
        fallbackAccountIds: ['work'],
        acquireTransition: async () => ({ release: async () => {} }),
        acquireManifest: async () => ({ release: async () => {} }),
        acquireRefresh: async () => ({ release: async () => {} }),
      },
      getLocalAuth: async (accountId) =>
        accountId === 'main'
          ? core.custodyTombstoneOAuth('anthropic')
          : real('access-work-secret', 'refresh-work-secret'),
      isCommitted: async () => false,
      snapshotSidecars: async () => ({
        config: config.slice(),
        state: state.slice(),
      }),
      writeManifestBindings: async () => {},
      writeSidecarAccount: async () => {
        config = new TextEncoder().encode('{"access":""}\n')
        state = new TextEncoder().encode('{"refresh":"claustrum-tombstone"}\n')
      },
      verifyTarget: async () => true,
      verifyCommitted: async () => false,
      restoreSidecars: async (snapshot) => {
        expect(mode).toBe('local')
        config = snapshot.config!.slice()
        state = snapshot.state!.slice()
      },
      verifyRollback: async () =>
        JSON.stringify(config) === JSON.stringify(before.config) &&
        JSON.stringify(state) === JSON.stringify(before.state),
      setMode: async (target: 'local' | 'claustrum') => {
        mode = target
        return 'changed'
      },
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'custody_transition_failed',
      stage: 'post_commit_readback',
    })
    expect(mode).toBe('local')
    expect(config).toEqual(before.config)
    expect(state).toEqual(before.state)
  })

  test('custody: failed committed readback leaves sidecars tombstoned when mode revert fails', async () => {
    const plan = await preflightClaustrumTakeover(preflightInput())
    let mode: string = 'local'
    let restored = false

    const error = await executeClaustrumTakeover(plan, {
      locks: {
        storagePath: '/storage.json',
        manifestPath: '/handles.json',
        fallbackAccountIds: ['work'],
        acquireTransition: async () => ({ release: async () => {} }),
        acquireManifest: async () => ({ release: async () => {} }),
        acquireRefresh: async () => ({ release: async () => {} }),
      },
      getLocalAuth: async (accountId) =>
        accountId === 'main'
          ? core.custodyTombstoneOAuth('anthropic')
          : real('access-work-secret', 'refresh-work-secret'),
      isCommitted: async () => false,
      snapshotSidecars: async () => ({ config: null, state: null }),
      writeManifestBindings: async () => {},
      writeSidecarAccount: async () => {},
      verifyTarget: async () => true,
      verifyCommitted: async () => false,
      restoreSidecars: async () => {
        restored = true
      },
      verifyRollback: async () => true,
      setMode: async (target: 'local' | 'claustrum') => {
        if (target === 'local') throw new Error('disk full')
        mode = target
        return 'changed'
      },
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'custody_transition_failed',
      stage: 'post_commit_readback',
    })
    expect(String(error)).toContain('mode is claustrum and unverified')
    expect(mode).toBe('claustrum')
    expect(restored).toBe(false)
  })

  test('custody: takeover refuses changed local material before any write', async () => {
    const plan = await preflightClaustrumTakeover(preflightInput())
    let snapshots = 0
    let writes = 0
    const error = await executeClaustrumTakeover(plan, {
      locks: {
        storagePath: '/storage.json',
        manifestPath: '/handles.json',
        fallbackAccountIds: ['work'],
        acquireTransition: async () => ({ release: async () => {} }),
        acquireManifest: async () => ({ release: async () => {} }),
        acquireRefresh: async () => ({ release: async () => {} }),
      },
      getLocalAuth: async (accountId) =>
        accountId === 'main'
          ? core.custodyTombstoneOAuth('anthropic')
          : real('changed-access', 'changed-refresh'),
      isCommitted: async () => false,
      snapshotSidecars: async () => {
        snapshots++
        return { config: null, state: null }
      },
      writeManifestBindings: async () => {
        writes++
      },
      writeSidecarAccount: async () => {
        writes++
      },
      verifyTarget: async () => true,
      verifyCommitted: async () => true,
      restoreSidecars: async () => {},
      verifyRollback: async () => true,
      setMode: async () => 'changed',
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'custody_transition_failed',
      stage: 'reverify_fingerprint',
      accountId: 'work',
    })
    expect(snapshots).toBe(0)
    expect(writes).toBe(0)
  })

  test('custody: live takeover tombstones fallback refresh and commits mode last', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'custody-live-takeover-'))
    const storagePath = join(directory, 'accounts.json')
    const manifestPath = join(directory, 'handles.json')
    const mainHandle = `ckh_${'M'.repeat(43)}`
    const workHandle = `ckh_${'W'.repeat(43)}`
    const hostReads: string[] = []
    const cacheModes: string[] = []
    const manifestWrites: string[] = []
    let modeAtFinalVerification = 'local'
    try {
      await core.saveAccounts(
        {
          version: 1,
          claustrum: { handlesFile: manifestPath, mode: 'local' },
          accounts: [
            {
              id: 'work',
              label: 'work',
              type: 'oauth',
              access: 'access-work-secret',
              refresh: 'refresh-work-secret',
              expires: now + 60_000,
              claustrumHandle: workHandle,
              enabled: true,
            },
          ],
        },
        storagePath,
      )
      await expect(
        core.writeCustodyHandleManifestEntry({
          path: manifestPath,
          entry: {
            label: 'main',
            handle: mainHandle,
            credentialId: core.custodyCredentialId('main'),
          },
        }),
      ).resolves.toEqual({ status: 'written' })
      const cache = {
        get: async (handle: string, minTtlMs = 0) => {
          cacheModes.push(
            core.getClaustrumMode(await core.loadAccounts(storagePath)),
          )
          return {
            credentialId:
              handle === mainHandle
                ? core.custodyCredentialId('main')
                : core.custodyCredentialId('work'),
            recordVersion: 7,
            access: 'vault-access',
            refresh: 'vault-refresh',
            expiresAt: now + minTtlMs + 1,
            state: 'usable' as const,
          }
        },
      }
      const fallbackManager = {
        withAccountRefreshLock: async <T>(_id: string, fn: () => Promise<T>) =>
          fn(),
      }
      const deps = createLiveCustodyDeps({
        storagePath,
        cache,
        latestGetAuth: async () => {
          hostReads.push('get')
          return core.custodyTombstoneOAuth('anthropic')
        },
        now,
        fallbackManager: fallbackManager as never,
        writeManifestEntryLocked: async (...args) => {
          manifestWrites.push(args[0].entry.label)
          return core.writeCustodyHandleManifestEntryLocked(...args)
        },
      })
      const storage = await core.loadAccounts(storagePath)
      const plan = await preflightClaustrumTakeover(
        await deps.preflightInput(
          { id: 'main', label: 'main', enabled: true },
          storage?.accounts ?? [],
        ),
      )

      await expect(
        executeClaustrumTakeover(plan, deps.takeoverDeps(plan)),
      ).resolves.toBe('changed')

      const committed = await core.loadAccounts(storagePath)
      const work = committed?.accounts.find((account) => account.id === 'work')
      expect(work).toMatchObject({
        access: '',
        refresh: core.custodyTombstoneKey('anthropic'),
        expires: 0,
      })
      expect(committed?.claustrum?.mode).toBe('claustrum')
      modeAtFinalVerification = committed?.claustrum?.mode ?? 'local'
      expect(modeAtFinalVerification).toBe('claustrum')
      expect(cacheModes.slice(-4)).toEqual([
        'local',
        'local',
        'claustrum',
        'claustrum',
      ])
      expect(manifestWrites).toEqual(['work'])
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      expect(manifest.providers[0].accounts).toEqual([
        {
          label: 'main',
          handle: mainHandle,
          credential_id: core.custodyCredentialId('main'),
        },
        {
          label: 'work',
          handle: workHandle,
          credential_id: core.custodyCredentialId('work'),
        },
      ])
      expect(hostReads.length).toBeGreaterThan(1)
      expect(deps.hostAuth).not.toHaveProperty('set')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('custody: local exit changes only the persisted mode', async () => {
    const calls: string[] = []
    await expect(
      executeLocalExit({
        setMode: async (mode) => {
          calls.push(mode)
          return 'changed'
        },
      }),
    ).resolves.toBe('changed')
    expect(calls).toEqual(['local'])
  })
})
