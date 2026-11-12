import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
  NATIVE_VAULT_NO_ACCOUNT_MESSAGE,
  type NativeCustodyClient,
  NativeVaultQuotaPolicyError,
  nativeAccountPolicy,
  sessionCacheActivity,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { createNativeAnthropicSource } from '../v2/source.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'

const cleanups: Array<() => unknown> = []
const pending: Promise<unknown>[] = []
afterEach(async () => {
  await Promise.all(pending.splice(0))
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function vaultFixture() {
  const identity = '11111111-2222-4333-8444-555555555555'
  const credentialId = 'oauth:anthropic'
  let networkCalls = 0
  const noNetwork: typeof fetch = Object.assign(
    async () => {
      networkCalls++
      throw new Error('NETWORK FORBIDDEN')
    },
    { preconnect: fetch.preconnect },
  )
  const originalFetch = globalThis.fetch
  globalThis.fetch = noNetwork
  cleanups.push(() => {
    globalThis.fetch = originalFetch
  })
  const client: NativeCustodyClient = {
    async listScoped() {
      return {
        view: 'offline-repro',
        rows: [
          {
            id: credentialId,
            accountId: identity,
            credentialType: 'oauth',
            categories: ['anthropic-native'],
            refreshAdapter: 'anthropic',
            serves: ['anthropic'],
            providerIds: [],
            operations: ['read'],
            state: 'active',
            recordVersion: 7,
            createdAtMs: null,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      return {
        credentialId,
        accountId: identity,
        material: 'sk-ant-oat01-SYNTHETIC',
        recordVersion: 7,
        expiresAtMs: Date.now() + 3600_000,
      }
    },
    async reportAuthFailureScoped() {
      throw new Error('UNEXPECTED AUTH FAILURE')
    },
    close() {},
  }
  const f = await migrateNativeOpencodeFixture({
    root: await mkdtemp(join(tmpdir(), 'vault-floor-data-')),
    lifetime: {
      deferCleanup(fn) {
        cleanups.push(fn)
      },
      trackDetached(p) {
        pending.push(p)
      },
    },
    legacyConfig: { version: 1, accounts: [] },
    legacyState: { version: 1, accounts: {} },
  })
  await writeFile(
    f.enrollmentPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: nativeVaultPaths(f.paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: {
      env: f.env,
      connect: async () => client,
      readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    },
  })
  cleanups.push(() => runtime.close())
  await runtime.vault.refresh()
  const roster = await runtime.vault.read()
  await store.updateSettings(() => ({
    mainAccountId: roster!.rows[0]!.routeId,
    claustrum: {
      primaryAccount: { credentialId, accountId: identity, state: 'active' },
    },
    quota: {
      enabled: true,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
    },
    routing: { mode: 'sticky-balanced' },
  }))
  const receipt = await runtime.authorizeVault('main')
  async function quota(remaining: number, resetsAt?: string) {
    const checkedAt = Date.now()
    await runtime.vault.publish(receipt, {
      quota: {
        accountIdentity: identity,
        checkedAt,
        five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
        seven_day: {
          usedPercent: 100 - remaining,
          remainingPercent: remaining,
          checkedAt,
          resetsAt,
        },
      },
    })
  }
  const source = createNativeAnthropicSource({
    runtime,
    paths: f.paths,
    fetch: noNetwork,
    requestOptions: () => ({}),
  })
  cleanups.push(() => source.close())
  const choose = async (sessionID: string) =>
    source.chooseAccount({
      phase: 'request',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-5',
      sessionID,
      agent: 'build',
      kind: 'primary',
    })
  return {
    runtime,
    store,
    quota,
    choose,
    client,
    networkCalls: () => networkCalls,
  }
}

test('vault quota floors refuse new OpenCode 2 sessions without asking for sign-in or sending requests', async () => {
  const { runtime, store, quota, choose, networkCalls } = await vaultFixture()
  await quota(21)
  expect(await choose('pinned')).toBe('main')
  await quota(20)
  expect(await choose('pinned')).toBe('main')
  const refusal = await choose('new').catch((error: unknown) => error)
  expect(refusal).toBeInstanceOf(NativeVaultQuotaPolicyError)
  const policyError = refusal as NativeVaultQuotaPolicyError
  expect(policyError.name).toBe('NativeVaultQuotaPolicyError')
  expect(policyError.status).toBe(429)
  expect(policyError.message).toContain('quota floor')
  expect(Number(policyError.headers.get('retry-after'))).toBeGreaterThan(0)
  expect(policyError.retryAfter).toBe(
    Number(policyError.headers.get('retry-after')),
  )
  expect(policyError.body).toEqual({
    type: 'error',
    error: { type: 'rate_limit_error', message: policyError.message },
  })
  expect(policyError.message).toContain('Retry in ')
  expect(policyError.message).not.toContain('signing in')
  expect(policyError.message).not.toContain('SYNTHETIC')
  await quota(19)
  const snapshot = await runtime.read()
  expect(snapshot.accounts[0]!.state).toBe('active')
  expect(
    nativeAccountPolicy(snapshot.accounts[0]!, snapshot, 'claude-sonnet-5'),
  ).toMatchObject({
    status: 'blocked',
    reason: 'quota-ineligible',
  })
  await expect(choose('new')).rejects.toMatchObject({
    status: 429,
    message: expect.stringContaining('/claude → Killswitch / Quota'),
  })
  await store.updateSettings((s) => ({
    ...s,
    quota: { enabled: true, minimumRemaining: { five_hour: 3, seven_day: 3 } },
  }))
  expect(await choose('new')).toBe('main')
  await store.updateSettings((s) => ({
    ...s,
    quota: { enabled: true, minimumRemaining: { five_hour: 0, seven_day: 0 } },
    killswitch: { enabled: true, main: { five_hour: 0, seven_day: 20 } },
  }))
  await expect(choose('killswitch')).rejects.toMatchObject({
    name: 'NativeVaultQuotaPolicyError',
    status: 429,
    message: expect.stringContaining('killswitch'),
  })
  await store.updateSettings((s) => ({
    ...s,
    routing: { mode: 'sticky-balanced', maxSameAccountWait: '0' },
  }))
  const stopped = (await choose('no-auto-retry').catch(
    (error: unknown) => error,
  )) as NativeVaultQuotaPolicyError
  expect(stopped.status).toBe(412)
  expect(stopped.headers.has('retry-after')).toBe(false)
  expect(stopped.body.error.type).toBe('FAILED_PRECONDITION')
  expect(stopped.message).not.toMatch(
    /429|500|502|503|504|524|retry|rate.?limit/i,
  )
  expect(networkCalls()).toBe(0)
})

test('host retry cap gives OpenCode 2 a named 26-hour pool reset without dispatch on re-ask', async () => {
  const { store, quota, choose, networkCalls } = await vaultFixture()
  const resetAt = new Date(Date.now() + 26 * 3_600_000).toISOString()
  await store.updateSettings((settings) => ({
    ...settings,
    routing: { mode: 'sticky-balanced', maxSameAccountWait: 'max' },
  }))
  const sessionID = 'long-reset-pool'
  sessionCacheActivity.record(sessionID, 'main', 26 * 3_600_000, Date.now())
  cleanups.push(() => sessionCacheActivity.forget(sessionID))
  await quota(0, resetAt)
  for (let attempt = 0; attempt < 2; attempt++) {
    const refusal = (await choose(sessionID).catch(
      (error: unknown) => error,
    )) as NativeVaultQuotaPolicyError
    expect(refusal).toBeInstanceOf(NativeVaultQuotaPolicyError)
    expect(refusal.headers.get('retry-after')).toBe('900')
    expect(refusal.message).toContain('weekly limit')
    expect(refusal.message).toContain('UTC (in 26 h)')
    expect(refusal.message).toContain('Retrying every 15 minutes.')
    expect(networkCalls()).toBe(0)
  }
})

test('OpenCode 2 vault accounts needing sign-in retain the existing refusal', async () => {
  const { runtime, choose, client, networkCalls } = await vaultFixture()
  const list = client.listScoped.bind(client)
  client.listScoped = async (input) => {
    const result = await list(input)
    return {
      ...result,
      rows: result.rows.map((row) => ({ ...row, state: 'needs_reauth' })),
    }
  }
  await runtime.vault.refresh()
  await expect(choose('needs-sign-in')).rejects.toMatchObject({
    name: 'NativeVaultNoAccountError',
    message: NATIVE_VAULT_NO_ACCOUNT_MESSAGE,
  })
  expect(networkCalls()).toBe(0)
})
