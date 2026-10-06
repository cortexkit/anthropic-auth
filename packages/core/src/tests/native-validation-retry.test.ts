import { expect } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { NativeLocalCredentialValidation } from '../native-credential-validation.ts'
import {
  decodeNativeRuntime,
  type NativeLocalValidationRetry,
  NativeRuntimeError,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'
import type { NativeLocalPoolBinding } from '../pool-binding.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const storageId = 'a'.repeat(64)
const binding: NativeLocalPoolBinding & { readonly identity: string } = {
  kind: 'local',
  storageId,
  rowId: 'synthetic-row-A',
  credentialEpoch: 4,
  identity: 'synthetic-account-A',
}
const subject: NativeLocalValidationRetry['subject'] = {
  binding: { ...binding },
  credentialFingerprint:
    '008f37156dffc3a2d0fc5793e4115ced8dd87f9609aa0e14f11aa09f45daaf04',
  version: {
    accessFingerprint: '270863a0169db796',
    expires: 1_000,
    lastRefreshedAt: 100,
  },
}
const retry: NativeLocalValidationRetry = {
  subject,
  checkedAt: 200,
  nextRetryAt: 300,
}
const proof: NativeLocalCredentialValidation = {
  ...subject,
  version: { ...subject.version, accessFingerprint: 'b'.repeat(16) },
}

function runtime(
  validationRetry: unknown,
  enclosingBinding: unknown = binding,
) {
  return {
    version: 1,
    storageId,
    accounts: {
      [binding.rowId]: { binding: enclosingBinding, validationRetry },
    },
  }
}

function without(value: object, key: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value }
  delete result[key]
  return result
}

function richState(): NativeRuntimeState {
  return decodeNativeRuntime(
    {
      version: 1,
      storageId,
      relay: { token: 'synthetic-relay-metadata' },
      accounts: {
        [binding.rowId]: {
          binding: { ...binding },
          credentialValidation: structuredClone(proof),
          validationRetry: structuredClone(retry),
          lastUsed: 0,
          lastRefreshedAt: 100,
          lastRefreshError: {
            message: 'synthetic refresh failure',
            checkedAt: 180,
            nextRetryAt: 280,
            retryCount: 1,
            accountIdentity: binding.identity,
            tokenHash: 'c'.repeat(64),
            refreshTokenFingerprint: 'd'.repeat(16),
            status: 503,
            permanent: false,
          },
          refreshErrorClearedAt: 0,
          refreshLeaseId: 'synthetic-lease',
          refreshLeaseUntil: 400,
          refreshLeaseTokenHash: 'c'.repeat(64),
          lastQuotaRefreshError: {
            message: 'synthetic quota failure',
            checkedAt: 190,
            nextRetryAt: 290,
            accountIdentity: binding.identity,
          },
          quotaErrorGeneration: 0,
          quotaErrorClearedAt: 0,
          quotaCheckedAt: 100,
          quotaToken: 'e'.repeat(16),
          profile: {
            tier: 'max',
            orgType: 'individual',
            checkedAt: 100,
            accountIdentity: binding.identity,
            providerAccountUuid: binding.identity,
            tokenFingerprint: 'e'.repeat(16),
          },
          prime: { count: 1, inputTokens: 2, outputTokens: 3, since: 0 },
          authLineageId: 'synthetic-lineage',
          primeAuthLineageRefreshTokenFingerprint: 'd'.repeat(16),
        },
        'synthetic-row-B': {
          binding: {
            kind: 'local',
            storageId,
            rowId: 'synthetic-row-B',
            credentialEpoch: 1,
          },
          lastUsed: 0,
        },
        'synthetic-vault-route': {
          binding: {
            kind: 'custody',
            storageId,
            routeId: 'synthetic-vault-route',
            credentialId: 'synthetic-vault-credential',
            accountIdentity: 'synthetic-vault-account',
            recordVersion: 0,
          },
          profile: {
            tier: 'max',
            orgType: 'team',
            checkedAt: 0,
            accountIdentity: 'synthetic-vault-account',
          },
        },
      },
    },
    storageId,
  )
}

async function fixture() {
  const parent = join(
    import.meta.dir,
    '../../../../node_modules/.cache/native-validation-retry',
  )
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'runtime-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return join(root, 'private', 'runtime.json')
}

test('validation retry round-trips its exact token-free tuple without mutating callers or other fields', async () => {
  const path = await fixture()
  const input = richState()
  const before = structuredClone(input)
  const decoded = decodeNativeRuntime(input, storageId)
  expect(decoded).toEqual(before)
  expect(decoded.accounts[binding.rowId]!.validationRetry).not.toBe(
    input.accounts[binding.rowId]!.validationRetry,
  )
  for (const key of ['binding', 'version'] as const)
    expect(
      decoded.accounts[binding.rowId]!.validationRetry!.subject[key],
    ).not.toBe(input.accounts[binding.rowId]!.validationRetry!.subject[key])
  decoded.accounts[binding.rowId]!.lastUsed = 9
  expect(input).toEqual(before)
  expect(await updateNativeRuntime(path, storageId, () => input)).toEqual(
    before,
  )
  expect(await readNativeRuntime(path, storageId)).toEqual({
    status: 'ready',
    state: before,
  })
  expect(input).toEqual(before)
  const bytes = await readFile(path, 'utf8')
  const saved = JSON.parse(bytes).accounts[binding.rowId].validationRetry
  expect(saved).toEqual(retry)
  expect(Object.keys(saved).sort()).toEqual([
    'checkedAt',
    'nextRetryAt',
    'subject',
  ])
  expect(Object.keys(saved.subject).sort()).toEqual([
    'binding',
    'credentialFingerprint',
    'version',
  ])
  expect(Object.keys(saved.subject.binding).sort()).toEqual([
    'credentialEpoch',
    'identity',
    'kind',
    'rowId',
    'storageId',
  ])
  expect(Object.keys(saved.subject.version).sort()).toEqual([
    'accessFingerprint',
    'expires',
    'lastRefreshedAt',
  ])
  for (const forbidden of ['"access"', '"refresh"', '"apiKey"'])
    expect(bytes).not.toContain(forbidden)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
})

test('validation retry extra-key control rejects every layer including raw secrets and error text', () => {
  const secret = 'sk-ant-oat01-synthetic-bearer-secret'
  for (const [key, value] of Object.entries({
    extra: true,
    message: 'synthetic raw provider error',
    error: 'synthetic raw provider error',
    access: secret,
    refresh: 'synthetic-refresh-secret',
    apiKey: 'synthetic-api-secret',
    retryCount: 1,
    type: 'api',
    accountIdentity: binding.identity,
    tokenHash: 'a'.repeat(64),
    credentialValidation: subject,
    status: 'proven',
  })) {
    for (const candidate of [
      { ...retry, [key]: value },
      { ...retry, subject: { ...subject, [key]: value } },
      {
        ...retry,
        subject: { ...subject, binding: { ...binding, [key]: value } },
      },
      {
        ...retry,
        subject: { ...subject, version: { ...subject.version, [key]: value } },
      },
    ]) {
      expect(() => decodeNativeRuntime(runtime(candidate), storageId)).toThrow(
        'Anthropic runtime state is invalid',
      )
    }
  }
})

test('validation retry binding mismatch control rejects cross-row storage epoch and identity reuse without publication', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => richState())
  const before = await readFile(path)
  for (const changed of [
    { ...binding, storageId: 'b'.repeat(64) },
    { ...binding, rowId: 'synthetic-row-B' },
    { ...binding, credentialEpoch: 5 },
    { ...binding, identity: 'synthetic-account-B' },
  ]) {
    const candidate = runtime({
      ...retry,
      subject: { ...subject, binding: changed },
    })
    expect(() => decodeNativeRuntime(candidate, storageId)).toThrow(
      'Anthropic runtime state is invalid',
    )
    await expect(
      updateNativeRuntime(path, storageId, () =>
        decodeNativeRuntime(candidate, storageId),
      ),
    ).rejects.toMatchObject({ code: 'invalid-runtime' })
    expect(await readFile(path)).toEqual(before)
  }
  for (const changed of [
    { ...binding, rowId: 'synthetic-row-B' },
    { ...binding, storageId: 'b'.repeat(64) },
    { ...binding, credentialEpoch: 5 },
    { ...binding, identity: 'synthetic-account-B' },
  ]) {
    const copied = {
      version: 1,
      storageId: changed.storageId,
      accounts: {
        [changed.rowId]: { binding: changed, validationRetry: retry },
      },
    }
    expect(() => decodeNativeRuntime(copied, changed.storageId)).toThrow(
      'Anthropic runtime state is invalid',
    )
  }
})

test('validation retry rejects missing required keys and malformed record shapes', () => {
  const invalid: unknown[] = [undefined, null, [], 'synthetic error', 0, {}]
  for (const key of ['subject', 'checkedAt', 'nextRetryAt'])
    invalid.push(without(retry, key), { ...retry, [key]: undefined })
  for (const key of ['binding', 'credentialFingerprint', 'version'])
    invalid.push({ ...retry, subject: without(subject, key) })
  for (const key of [
    'kind',
    'storageId',
    'rowId',
    'credentialEpoch',
    'identity',
  ])
    invalid.push({
      ...retry,
      subject: { ...subject, binding: without(binding, key) },
    })
  for (const key of ['accessFingerprint', 'expires'])
    invalid.push({
      ...retry,
      subject: { ...subject, version: without(subject.version, key) },
    })
  for (const value of [undefined, null, [], 'synthetic error', 0]) {
    invalid.push({ ...retry, subject: value })
    for (const key of ['binding', 'version'])
      invalid.push({ ...retry, subject: { ...subject, [key]: value } })
  }
  for (const candidate of invalid)
    expect(() => decodeNativeRuntime(runtime(candidate), storageId)).toThrow(
      'Anthropic runtime state is invalid',
    )
})

test('validation retry rejects every malformed nested binding field', () => {
  for (const [key, values] of Object.entries({
    kind: [undefined, 'custody', 'api', '', 0],
    storageId: [undefined, '', 'a'.repeat(16), 'A'.repeat(64), 'g'.repeat(64)],
    rowId: [undefined, '', ' row', 'row ', 0],
    credentialEpoch: [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4'],
    identity: [undefined, '', ' account', 'account ', 0],
  })) {
    for (const value of values)
      expect(() =>
        decodeNativeRuntime(
          runtime({
            ...retry,
            subject: { ...subject, binding: { ...binding, [key]: value } },
          }),
          storageId,
        ),
      ).toThrow('Anthropic runtime state is invalid')
  }
})

test('validation retry rejects malformed lineage access fingerprints expiry and strict refresh stamps', () => {
  for (const credentialFingerprint of [
    undefined,
    '',
    'a'.repeat(16),
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    'synthetic-refresh-secret',
    ` ${subject.credentialFingerprint}`,
  ]) {
    expect(() =>
      decodeNativeRuntime(
        runtime({ ...retry, subject: { ...subject, credentialFingerprint } }),
        storageId,
      ),
    ).toThrow('Anthropic runtime state is invalid')
  }
  for (const accessFingerprint of [
    undefined,
    '',
    'a'.repeat(15),
    'a'.repeat(17),
    'a'.repeat(64),
    'A'.repeat(16),
    'g'.repeat(16),
    'sk-ant-oat01-synthetic-bearer-secret',
    'synthetic raw provider error',
  ]) {
    expect(() =>
      decodeNativeRuntime(
        runtime({
          ...retry,
          subject: {
            ...subject,
            version: { ...subject.version, accessFingerprint },
          },
        }),
        storageId,
      ),
    ).toThrow('Anthropic runtime state is invalid')
  }
  for (const field of ['expires', 'lastRefreshedAt']) {
    const invalid: unknown[] = [
      undefined,
      null,
      -1,
      0.5,
      '100',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]
    if (field === 'expires') invalid.push(0)
    for (const value of invalid)
      expect(() =>
        decodeNativeRuntime(
          runtime({
            ...retry,
            subject: {
              ...subject,
              version: { ...subject.version, [field]: value },
            },
          }),
          storageId,
        ),
      ).toThrow('Anthropic runtime state is invalid')
  }
})

test('validation retry is refused on unknown identity vault and API entries', () => {
  for (const enclosing of [
    without(binding, 'identity'),
    { ...binding, identity: undefined },
    { kind: 'api', storageId, rowId: binding.rowId },
    {
      kind: 'custody',
      storageId,
      routeId: binding.rowId,
      credentialId: 'synthetic-vault-credential',
      accountIdentity: binding.identity,
      recordVersion: 1,
    },
  ])
    expect(() =>
      decodeNativeRuntime(runtime(retry, enclosing), storageId),
    ).toThrow('Anthropic runtime state is invalid')
})

test('validation retry uses safe ordered required observation and retry times', () => {
  for (const key of ['checkedAt', 'nextRetryAt']) {
    for (const value of [
      undefined,
      null,
      -1,
      0.5,
      '200',
      'synthetic raw provider error',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(() =>
        decodeNativeRuntime(runtime({ ...retry, [key]: value }), storageId),
      ).toThrow('Anthropic runtime state is invalid')
  }
  expect(() =>
    decodeNativeRuntime(runtime({ ...retry, nextRetryAt: 199 }), storageId),
  ).toThrow('Anthropic runtime state is invalid')
  for (const [checkedAt, nextRetryAt] of [
    [0, 0],
    [0, 1],
    [200, 200],
    [200, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ]) {
    const candidate = runtime({ ...retry, checkedAt, nextRetryAt })
    expect<unknown>(decodeNativeRuntime(candidate, storageId)).toEqual(
      candidate,
    )
  }
})

test('validation retry preserves strict stamp absence versus zero through disk round-trip', async () => {
  const path = await fixture()
  for (const version of [
    { accessFingerprint: subject.version.accessFingerprint, expires: 1_000 },
    { ...subject.version, lastRefreshedAt: 0 },
  ]) {
    const candidate = runtime({ ...retry, subject: { ...subject, version } })
    await updateNativeRuntime(path, storageId, () =>
      decodeNativeRuntime(candidate, storageId),
    )
    const read = await readNativeRuntime(path, storageId)
    expect<unknown>(read).toEqual({ status: 'ready', state: candidate })
    if (read.status !== 'ready') throw new Error('Runtime fixture missing')
    const saved = read.state.accounts[binding.rowId]!.validationRetry!
    expect(Object.hasOwn(saved.subject.version, 'lastRefreshedAt')).toBe(
      Object.hasOwn(version, 'lastRefreshedAt'),
    )
    expect(saved.subject.version.lastRefreshedAt).toBe(
      'lastRefreshedAt' in version ? 0 : undefined,
    )
  }
})

test('adding and removing validation retry neither creates nor erases positive evidence or account metadata', async () => {
  for (const hasProof of [false, true]) {
    const path = await fixture()
    const base = richState()
    delete base.accounts[binding.rowId]!.validationRetry
    if (!hasProof) delete base.accounts[binding.rowId]!.credentialValidation
    expect(await updateNativeRuntime(path, storageId, () => base)).toEqual(base)
    const before = await readFile(path)
    const added = await updateNativeRuntime(path, storageId, (current) => {
      current.accounts[binding.rowId]!.validationRetry = structuredClone(retry)
      return current
    })
    expect(added).toEqual({
      ...base,
      accounts: {
        ...base.accounts,
        [binding.rowId]: {
          ...base.accounts[binding.rowId]!,
          validationRetry: retry,
        },
      },
    })
    const read = await readNativeRuntime(path, storageId)
    expect(read).toEqual({ status: 'ready', state: added })
    expect(
      Object.hasOwn(added.accounts[binding.rowId]!, 'credentialValidation'),
    ).toBe(hasProof)
    const removed = await updateNativeRuntime(path, storageId, (current) => {
      delete current.accounts[binding.rowId]!.validationRetry
      return current
    })
    expect(removed).toEqual(base)
    expect(await readFile(path)).toEqual(before)
  }
})

test('validation retry does not normalize valid changed credential tuple components', () => {
  for (const changed of [
    { ...subject, credentialFingerprint: 'b'.repeat(64) },
    {
      ...subject,
      version: { ...subject.version, accessFingerprint: 'c'.repeat(16) },
    },
    { ...subject, version: { ...subject.version, expires: 1_001 } },
    { ...subject, version: { ...subject.version, lastRefreshedAt: 101 } },
  ]) {
    const candidate = runtime({ ...retry, subject: changed })
    const before = structuredClone(candidate)
    const decoded = decodeNativeRuntime(candidate, storageId)
    expect<unknown>(decoded).toEqual(before)
    expect(candidate).toEqual(before)
    expect(
      decoded.accounts[binding.rowId]!.credentialValidation,
    ).toBeUndefined()
  }
})

test('validation retry secret-bearing input reports redacted errors and preserves exact persisted bytes', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => richState())
  const before = await readFile(path)
  for (const secret of [
    'sk-ant-oat01-synthetic-bearer-secret',
    'synthetic-refresh-secret',
    'synthetic raw provider error',
  ]) {
    const candidate = runtime({
      ...retry,
      subject: { ...subject, credentialFingerprint: secret },
    })
    await expect(
      updateNativeRuntime(path, storageId, () =>
        decodeNativeRuntime(candidate, storageId),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-runtime',
      message: 'Anthropic runtime state is invalid',
    })
    expect(await readFile(path)).toEqual(before)
    const malformedPath = await fixture()
    await mkdir(dirname(malformedPath), { mode: 0o700 })
    const bytes = JSON.stringify(candidate)
    await writeFile(malformedPath, bytes, { mode: 0o600 })
    try {
      await readNativeRuntime(malformedPath, storageId)
      throw new Error('Malformed retry was accepted')
    } catch (error) {
      expect(error).toBeInstanceOf(NativeRuntimeError)
      expect(String(error)).toBe(
        'NativeRuntimeError: Anthropic runtime state is invalid',
      )
      expect(String(error)).not.toContain(secret)
    }
    expect(await readFile(malformedPath, 'utf8')).toBe(bytes)
  }
})

test('validation retry does not relax same-epoch identity changes or monotone clear fences', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => richState())
  const before = await readFile(path)
  for (const key of [
    'refreshErrorClearedAt',
    'quotaErrorClearedAt',
    'quotaErrorGeneration',
  ] as const) {
    await expect(
      updateNativeRuntime(path, storageId, (current) => {
        delete current.accounts[binding.rowId]![key]
        return current
      }),
    ).rejects.toMatchObject({ code: 'runtime-conflict' })
    expect(await readFile(path)).toEqual(before)
  }
  for (const changed of [
    without(binding, 'identity'),
    { ...binding, identity: 'synthetic-account-B' },
  ]) {
    await expect(
      updateNativeRuntime(path, storageId, () =>
        decodeNativeRuntime(
          {
            version: 1,
            storageId,
            accounts: { [binding.rowId]: { binding: changed } },
          },
          storageId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'runtime-conflict' })
    expect(await readFile(path)).toEqual(before)
  }
  const unknownPath = await fixture()
  await updateNativeRuntime(unknownPath, storageId, () =>
    decodeNativeRuntime(
      {
        version: 1,
        storageId,
        accounts: {
          [binding.rowId]: { binding: without(binding, 'identity') },
        },
      },
      storageId,
    ),
  )
  const unknownBytes = await readFile(unknownPath)
  await expect(
    updateNativeRuntime(unknownPath, storageId, () =>
      decodeNativeRuntime(runtime(retry), storageId),
    ),
  ).rejects.toMatchObject({ code: 'runtime-conflict' })
  expect(await readFile(unknownPath)).toEqual(unknownBytes)
})
