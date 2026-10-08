import { expect, test } from 'bun:test'
import type { PoolRow, StoredCredential } from '@cortexkit/common-auth/store'
import {
  captureNativeMigrationPreparedProof,
  decodeNativeMigrationPreparedProof,
  nativeMigrationCredentialDigest,
  requireNativeMigrationPreparedProof,
} from '../native-migration-proof.ts'

const oauth: StoredCredential = {
  type: 'oauth',
  access: 'synthetic-access',
  refresh: 'synthetic-refresh',
  expires: 100,
  lastRefreshedAt: 10,
}
function row(credential: StoredCredential = oauth): PoolRow {
  return {
    id: 'main',
    type: credential.type,
    credential,
    credentialEpoch: 1,
    stamp: 'bound',
    identity: 'synthetic-identity',
    enabled: true,
    needsFirstReading: false,
    hasEntry: true,
    candidate: true,
  }
}
const runtime = { version: 1, accounts: { main: { lastUsed: 1 } } }

test('complete public descriptor detects access, expiry, refresh and refresh-stamp changes', () => {
  const original = nativeMigrationCredentialDigest(oauth)
  for (const change of [
    { access: 'changed' },
    { expires: 101 },
    { refresh: 'changed' },
    { lastRefreshedAt: 11 },
  ])
    expect(nativeMigrationCredentialDigest({ ...oauth, ...change })).not.toBe(
      original,
    )
  const { lastRefreshedAt: _stamp, ...unstamped } = oauth
  expect(nativeMigrationCredentialDigest(unstamped)).not.toBe(original)
})

test('API proof detects key, endpoint, header and absent header independently', () => {
  const api: StoredCredential = {
    type: 'api',
    apiKey: 'synthetic-key',
    baseURL: 'https://synthetic.invalid',
    authHeader: 'x-api-key',
  }
  const original = nativeMigrationCredentialDigest(api)
  for (const change of [
    { apiKey: 'changed' },
    { baseURL: 'https://other.invalid' },
    { authHeader: 'authorization-bearer' as const },
  ])
    expect(nativeMigrationCredentialDigest({ ...api, ...change })).not.toBe(
      original,
    )
  const { authHeader: _header, ...absent } = api
  expect(nativeMigrationCredentialDigest(absent)).not.toBe(original)
})

test('canonical projection accepts serialization order but detects runtime disagreement', () => {
  const proof = captureNativeMigrationPreparedProof([row()], runtime)
  expect(() =>
    requireNativeMigrationPreparedProof(proof, [row()], {
      accounts: { main: { lastUsed: 1 } },
      version: 1,
    }),
  ).not.toThrow()
  expect(() =>
    requireNativeMigrationPreparedProof(proof, [row()], {
      ...runtime,
      accounts: {},
    }),
  ).toThrow('prepared proof')
})

test('prepared recovery refuses identity absence, epoch re-add, missing proof and non-bound rows', () => {
  const proof = captureNativeMigrationPreparedProof([row()], runtime)
  for (const changed of [
    { ...row(), identity: undefined },
    { ...row(), identity: 'other' },
    { ...row(), credentialEpoch: 2 },
    { ...row(), stamp: 'mismatched' as const },
    { ...row(), torn: true as const },
    { ...row(), unbound: true as const },
  ])
    expect(() =>
      requireNativeMigrationPreparedProof(proof, [changed], runtime),
    ).toThrow('prepared proof')
  expect(() =>
    requireNativeMigrationPreparedProof(null, [row()], runtime),
  ).toThrow('prepared proof')
})

test('proof decoding never invokes getters, proxy traps or callbacks', () => {
  let calls = 0
  const proof = captureNativeMigrationPreparedProof([row()], runtime)
  const getter = {
    ...proof,
    get rows() {
      calls++
      return []
    },
  }
  const proxy = new Proxy(proof, {
    ownKeys() {
      calls++
      return []
    },
    get() {
      calls++
      return 1
    },
  })
  for (const value of [
    getter,
    proxy,
    {
      ...proof,
      toJSON() {
        calls++
        return {}
      },
    },
  ])
    expect(() => decodeNativeMigrationPreparedProof(value)).toThrow(
      'prepared proof',
    )
  expect(calls).toBe(0)
})

test('proof contains neither original tokens nor private stamp fields', () => {
  const text = JSON.stringify(
    captureNativeMigrationPreparedProof([row()], runtime),
  )
  expect(text).not.toContain('synthetic-access')
  expect(text).not.toContain('synthetic-refresh')
  expect(text).not.toContain('dispatch')
  expect(text).not.toContain('fingerprint')
})
