import { expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  isNativeLocalCredentialValidation,
  type NativeLocalCredentialMaterial,
  type NativeLocalCredentialValidation,
  nativeLocalCredentialValidationMatches,
} from '../native-credential-validation.ts'
import {
  decodeNativeRuntime,
  NativeRuntimeError,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'
import type { NativeLocalPoolBinding } from '../pool-binding.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite, TestLifetime } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()

const storageId = 'a'.repeat(64)
const binding: NativeLocalPoolBinding & { readonly identity: string } = {
  kind: 'local',
  storageId,
  rowId: 'synthetic-row-A',
  credentialEpoch: 4,
  identity: 'synthetic-account-A',
}
const material: NativeLocalCredentialMaterial = {
  type: 'oauth',
  access: 'synthetic-access-A',
  refresh: 'synthetic-refresh-A',
  expires: 1_000,
  lastRefreshedAt: 100,
}
// Fixed SHA-256 examples test the full refresh-lineage hash and truncated
// access-token hash without using the implementation to compute expected values.
const proof: NativeLocalCredentialValidation = {
  binding: { ...binding },
  credentialFingerprint:
    '008f37156dffc3a2d0fc5793e4115ced8dd87f9609aa0e14f11aa09f45daaf04',
  version: {
    accessFingerprint: '270863a0169db796',
    expires: 1_000,
    lastRefreshedAt: 100,
  },
}

function runtime(
  credentialValidation: unknown = proof,
  enclosingBinding: unknown = binding,
) {
  return {
    version: 1,
    storageId,
    accounts: {
      [binding.rowId]: { binding: enclosingBinding, credentialValidation },
    },
  }
}

function state(): NativeRuntimeState {
  return decodeNativeRuntime(runtime(), storageId)
}

async function fixture() {
  const parent = join(
    import.meta.dir,
    '../../../../node_modules/.cache/native-credential-validation',
  )
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'runtime-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return join(root, 'private', 'runtime.json')
}

test('exact OAuth evidence matches the independent lineage and access vectors without mutation', () => {
  const before = JSON.stringify({ proof, binding, material })
  expect(isNativeLocalCredentialValidation(proof)).toBe(true)
  expect(nativeLocalCredentialValidationMatches(proof, binding, material)).toBe(
    true,
  )
  expect(proof.credentialFingerprint).toHaveLength(64)
  expect(proof.credentialFingerprint).not.toBe(
    tokenFingerprint(material.refresh!),
  )
  expect(proof.version.accessFingerprint).toHaveLength(16)
  expect(JSON.stringify({ proof, binding, material })).toBe(before)
})

test('matching rejects every changed nested binding component even when credential bytes repeat', () => {
  for (const changed of [
    { ...binding, storageId: 'b'.repeat(64) },
    { ...binding, rowId: 'synthetic-row-B' },
    { ...binding, credentialEpoch: 5 },
    { ...binding, identity: 'synthetic-account-B' },
  ]) {
    expect(
      nativeLocalCredentialValidationMatches(proof, changed, material),
    ).toBe(false)
  }
})

test('matching compares lastRefreshedAt exactly including strict absence versus zero', () => {
  const unstampedProof = {
    ...proof,
    version: {
      accessFingerprint: proof.version.accessFingerprint,
      expires: 1_000,
    },
  }
  const { lastRefreshedAt: _stamp, ...unstampedMaterial } = material
  expect(
    nativeLocalCredentialValidationMatches(
      unstampedProof,
      binding,
      unstampedMaterial,
    ),
  ).toBe(true)
  expect(
    nativeLocalCredentialValidationMatches(proof, binding, {
      ...material,
      lastRefreshedAt: 101,
    }),
  ).toBe(false)
  expect(
    nativeLocalCredentialValidationMatches(proof, binding, unstampedMaterial),
  ).toBe(false)
  expect(
    nativeLocalCredentialValidationMatches(unstampedProof, binding, material),
  ).toBe(false)
  const zeroMaterial = { ...material, lastRefreshedAt: 0 }
  const zeroProof = {
    ...proof,
    version: { ...proof.version, lastRefreshedAt: 0 },
  }
  expect(
    nativeLocalCredentialValidationMatches(zeroProof, binding, zeroMaterial),
  ).toBe(true)
  expect(
    nativeLocalCredentialValidationMatches(
      unstampedProof,
      binding,
      zeroMaterial,
    ),
  ).toBe(false)
  expect(
    nativeLocalCredentialValidationMatches(
      zeroProof,
      binding,
      unstampedMaterial,
    ),
  ).toBe(false)
})

test('matching rejects changed refresh lineage, access token and expiry', () => {
  for (const changed of [
    { ...material, refresh: 'synthetic-refresh-B' },
    { ...material, access: 'synthetic-access-B' },
    { ...material, expires: 1_001 },
  ]) {
    expect(
      nativeLocalCredentialValidationMatches(proof, binding, changed),
    ).toBe(false)
  }
  for (const changed of [
    { ...proof, credentialFingerprint: 'b'.repeat(64) },
    { ...proof, credentialFingerprint: tokenFingerprint(material.refresh!) },
    {
      ...proof,
      version: { ...proof.version, accessFingerprint: 'b'.repeat(16) },
    },
    { ...proof, version: { ...proof.version, expires: 1_001 } },
  ]) {
    expect(
      nativeLocalCredentialValidationMatches(changed, binding, material),
    ).toBe(false)
  }
})

test('missing proof, unknown identity, non-OAuth and empty or unsafe material cannot match', () => {
  const { identity: _identity, ...unknownBinding } = binding
  expect(
    nativeLocalCredentialValidationMatches(undefined, binding, material),
  ).toBe(false)
  expect(nativeLocalCredentialValidationMatches(null, binding, material)).toBe(
    false,
  )
  expect(
    nativeLocalCredentialValidationMatches(proof, unknownBinding, material),
  ).toBe(false)
  expect(
    isNativeLocalCredentialValidation({ ...proof, binding: unknownBinding }),
  ).toBe(false)
  for (const changed of [
    undefined,
    { type: 'api', apiKey: 'synthetic-api-key' },
    { ...material, type: 'api' },
    { ...material, type: 'custody' },
    { type: 'oauth' },
    { ...material, access: undefined },
    { ...material, access: '' },
    { ...material, access: ' synthetic-access-A' },
    { ...material, refresh: '' },
    { ...material, refresh: ' ' },
    { ...material, refresh: undefined },
    { ...material, expires: undefined },
    { ...material, expires: 0 },
    { ...material, expires: -1 },
    { ...material, expires: 1.5 },
    { ...material, expires: Number.MAX_SAFE_INTEGER + 1 },
    { ...material, lastRefreshedAt: undefined },
    { ...material, lastRefreshedAt: -1 },
    { ...material, lastRefreshedAt: Number.NaN },
    { ...material, lastRefreshedAt: Number.POSITIVE_INFINITY },
    { ...material, lastRefreshedAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(
      nativeLocalCredentialValidationMatches(proof, binding, changed),
    ).toBe(false)
  }
})

test('closed proof and runtime decoders reject malformed keys, fingerprints, bindings and timestamps', () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...proof, binding: undefined },
    { ...proof, credentialFingerprint: undefined },
    { ...proof, version: undefined },
    { ...proof, validated: true },
    { ...proof, status: 'unvalidated' },
    { ...proof, checkedAt: 200 },
    { ...proof, refresh: material.refresh },
    { ...proof, binding: { ...binding, extra: true } },
    { ...proof, binding: { ...binding, identity: undefined } },
    { ...proof, binding: { ...binding, identity: '' } },
    { ...proof, binding: { ...binding, rowId: ' row' } },
    { ...proof, binding: { ...binding, storageId: 'a'.repeat(16) } },
    { ...proof, binding: { ...binding, credentialEpoch: 0 } },
    { ...proof, binding: { ...binding, credentialEpoch: 1.5 } },
    {
      ...proof,
      binding: { ...binding, credentialEpoch: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...proof, version: { ...proof.version, extra: true } },
    { ...proof, version: { ...proof.version, access: material.access } },
  ]
  for (const fingerprint of [
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    material.refresh,
    ` ${proof.credentialFingerprint}`,
  ]) {
    invalid.push({ ...proof, credentialFingerprint: fingerprint })
  }
  for (const fingerprint of [
    '',
    'a'.repeat(15),
    'a'.repeat(17),
    'A'.repeat(16),
    'g'.repeat(16),
    material.access,
    'sk-ant-oat01-synthetic-bearer',
  ]) {
    invalid.push({
      ...proof,
      version: { ...proof.version, accessFingerprint: fingerprint },
    })
  }
  for (const expires of [
    undefined,
    0,
    -1,
    1.5,
    '1000',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    invalid.push({ ...proof, version: { ...proof.version, expires } })
  }
  for (const lastRefreshedAt of [
    undefined,
    -1,
    0.5,
    '100',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    invalid.push({ ...proof, version: { ...proof.version, lastRefreshedAt } })
  }
  for (const candidate of invalid) {
    expect(isNativeLocalCredentialValidation(candidate)).toBe(false)
    expect(
      nativeLocalCredentialValidationMatches(candidate, binding, material),
    ).toBe(false)
    expect(() => decodeNativeRuntime(runtime(candidate), storageId)).toThrow(
      'Anthropic runtime state is invalid',
    )
  }
})

test('runtime proof belongs only to the enclosing known local binding, never vault or API entries', () => {
  const { identity: _identity, ...unknownBinding } = binding
  for (const enclosing of [
    unknownBinding,
    { ...binding, credentialEpoch: 5 },
    { ...binding, identity: 'synthetic-account-B' },
    { kind: 'api', storageId, rowId: binding.rowId },
    {
      kind: 'custody',
      storageId,
      routeId: binding.rowId,
      credentialId: 'synthetic-vault-credential',
      accountIdentity: binding.identity,
      recordVersion: 1,
    },
  ]) {
    expect(() =>
      decodeNativeRuntime(runtime(proof, enclosing), storageId),
    ).toThrow('Anthropic runtime state is invalid')
  }
  for (const changed of [
    { ...binding, storageId: 'b'.repeat(64) },
    { ...binding, rowId: 'synthetic-row-B' },
    { ...binding, credentialEpoch: 5 },
    { ...binding, identity: 'synthetic-account-B' },
  ]) {
    expect(() =>
      decodeNativeRuntime(runtime({ ...proof, binding: changed }), storageId),
    ).toThrow('Anthropic runtime state is invalid')
  }
  const noProof = {
    version: 1,
    storageId,
    accounts: { [binding.rowId]: { binding: unknownBinding } },
  }
  expect(
    decodeNativeRuntime(noProof, storageId).accounts[binding.rowId]!
      .credentialValidation,
  ).toBeUndefined()
})

test('expired but exact evidence remains valid without inferring serving freshness', () => {
  expect(material.expires!).toBeLessThan(Date.now())
  expect(nativeLocalCredentialValidationMatches(proof, binding, material)).toBe(
    true,
  )
  expect(
    decodeNativeRuntime(runtime(), storageId).accounts[binding.rowId]!
      .credentialValidation,
  ).toEqual(proof)
})

test('runtime writer and reader preserve proof without serializing raw secrets or exposing them in errors', async () => {
  const path = await fixture()
  expect(await updateNativeRuntime(path, storageId, () => state())).toEqual(
    state(),
  )
  expect(await readNativeRuntime(path, storageId)).toEqual({
    status: 'ready',
    state: state(),
  })
  const bytes = await readFile(path, 'utf8')
  expect(
    JSON.parse(bytes).accounts[binding.rowId].credentialValidation,
  ).toEqual(proof)
  for (const secret of [
    material.access!,
    material.refresh!,
    'synthetic-api-key',
  ]) {
    expect(bytes).not.toContain(secret)
  }
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
  try {
    await updateNativeRuntime(path, storageId, () =>
      decodeNativeRuntime(
        runtime({ ...proof, credentialFingerprint: material.refresh }),
        storageId,
      ),
    )
    throw new Error('invalid proof was accepted')
  } catch (error) {
    expect(error).toBeInstanceOf(NativeRuntimeError)
    expect(String(error)).toBe(
      'NativeRuntimeError: Anthropic runtime state is invalid',
    )
    expect(String(error)).not.toContain(material.refresh!)
    expect(String(error)).not.toContain(material.access!)
  }
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

test('clear-marker updates preserve existing proof byte-equivalent and never synthesize missing proof', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = JSON.stringify(
    JSON.parse(await readFile(path, 'utf8')).accounts[binding.rowId]
      .credentialValidation,
  )
  await updateNativeRuntime(path, storageId, (current) => {
    current.accounts[binding.rowId]!.refreshErrorClearedAt = 200
    current.accounts[binding.rowId]!.quotaErrorClearedAt = 200
    return current
  })
  const after = JSON.parse(await readFile(path, 'utf8')).accounts[binding.rowId]
  expect(JSON.stringify(after.credentialValidation)).toBe(before)
  const missingPath = await fixture()
  await updateNativeRuntime(missingPath, storageId, () => ({
    version: 1,
    storageId,
    accounts: { [binding.rowId]: { binding } },
  }))
  const updated = await updateNativeRuntime(
    missingPath,
    storageId,
    (current) => {
      current.accounts[binding.rowId]!.refreshErrorClearedAt = 200
      return current
    },
  )
  expect(
    Object.hasOwn(updated.accounts[binding.rowId]!, 'credentialValidation'),
  ).toBe(false)
  expect(await readFile(missingPath, 'utf8')).not.toContain(
    'credentialValidation',
  )
})

test('writer rejects carried proof after epoch advance but permits absent or newly bound evidence', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = await readFile(path, 'utf8')
  await expect(
    updateNativeRuntime(path, storageId, (current) => {
      current.accounts[binding.rowId]!.binding = {
        ...binding,
        credentialEpoch: 5,
      }
      return current
    }),
  ).rejects.toMatchObject({ code: 'invalid-runtime' })
  expect(await readFile(path, 'utf8')).toBe(before)
  const without = await updateNativeRuntime(path, storageId, (current) => {
    current.accounts[binding.rowId]!.binding = {
      ...binding,
      credentialEpoch: 5,
    }
    delete current.accounts[binding.rowId]!.credentialValidation
    return current
  })
  expect(without.accounts[binding.rowId]!.credentialValidation).toBeUndefined()
  const rebound = { ...binding, credentialEpoch: 6 }
  const newProof = { ...proof, binding: rebound }
  const updated = await updateNativeRuntime(path, storageId, (current) => {
    current.accounts[binding.rowId]!.binding = rebound
    current.accounts[binding.rowId]!.credentialValidation = newProof
    return current
  })
  expect(updated.accounts[binding.rowId]!.credentialValidation).toEqual(
    newProof,
  )
  expect(
    nativeLocalCredentialValidationMatches(newProof, rebound, material),
  ).toBe(true)
  await expect(
    updateNativeRuntime(path, storageId, () => state()),
  ).rejects.toMatchObject({ code: 'runtime-conflict' })
})

test('lifetime teardown drains the whole runtime body before deleting its fixture', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const lifetime = new TestLifetime()
  const releaseBody = Promise.withResolvers<void>()
  let bodyFinished = false
  lifetime.deferCleanup(async () => {
    if (!bodyFinished)
      throw new Error('Runtime fixture cleanup preceded body completion')
    await rm(dirname(dirname(path)), { recursive: true, force: true })
  })
  const body = lifetime.runBody(async () => {
    await releaseBody.promise
    expect(await readNativeRuntime(path, storageId)).toEqual({
      status: 'ready',
      state: state(),
    })
    bodyFinished = true
  })
  // Starting teardown must not remove files a paused body still needs to read.
  const finishing = lifetime.finish().then(
    () => undefined,
    (error: unknown) => error,
  )
  let failure: unknown
  try {
    expect(await readNativeRuntime(path, storageId)).toEqual({
      status: 'ready',
      state: state(),
    })
  } finally {
    releaseBody.resolve()
    const results = await Promise.all([body, finishing])
    failure = results[1]
  }
  expect(failure).toBeUndefined()
  expect(bodyFinished).toBe(true)
  expect(await readNativeRuntime(path, storageId)).toEqual({
    status: 'missing',
  })
})
