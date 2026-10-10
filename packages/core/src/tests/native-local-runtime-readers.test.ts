import { expect, spyOn } from 'bun:test'
import { constants } from 'node:fs'
import * as files from 'node:fs/promises'
import { join } from 'node:path'
import * as lockFs from '@cortexkit/common-auth/fs'
import { fingerprintOf } from '@cortexkit/common-auth/store'

import { hashRefreshToken } from '../accounts.ts'
import * as auth from '../auth.ts'
import * as identity from '../claude-code.ts'
import type { NativeLocalCredentialValidation } from '../native-credential-validation.ts'
import {
  createNativeLocalRuntimeReaders,
  type NativeLocalExternalPolicy,
} from '../native-local-runtime-readers.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshHooks,
  type NativeRefreshObservation,
  type NativeRefreshSubject,
} from '../native-refresh-coordinator.ts'
import {
  type NativeLocalRefreshError,
  type NativeRuntimeEntry,
  NativeRuntimeError,
} from '../native-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import * as pools from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const accountA =
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as identity.ProviderAccountUuid
const accountB = '11111111-2222-4333-8444-555555555555'
const now = 500
const allowed: NativeLocalExternalPolicy = { status: 'allowed' }
const material = {
  type: 'oauth' as const,
  access: 'synthetic-access-A',
  refresh: 'synthetic-refresh-A',
  expires: 1_000,
  lastRefreshedAt: 100,
}

async function fixture(
  externalPolicy: (
    subject: NativeRefreshSubject,
  ) => NativeLocalExternalPolicy = () => allowed,
) {
  const parent = join(
    import.meta.dir,
    '../../../../node_modules/.cache/native-local-runtime-readers',
  )
  await files.mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await files.mkdtemp(join(parent, 'runtime-'))
  deferCleanup(() => files.rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const subject: NativeLocalCredentialValidation = {
    binding: {
      kind: 'local',
      storageId: paths.storageId,
      rowId: 'synthetic-row-A',
      credentialEpoch: 1,
      identity: accountA,
    },
    credentialFingerprint: fingerprintOf(material),
    version: {
      accessFingerprint: tokenFingerprint(material.access),
      expires: material.expires,
      lastRefreshedAt: material.lastRefreshedAt,
    },
  }
  const hooks = createNativeLocalRuntimeReaders({
    paths,
    externalPolicy,
    now: () => now,
  })
  async function put(entry: NativeRuntimeEntry | undefined, value?: unknown) {
    await files.writeFile(
      paths.runtime,
      JSON.stringify(
        value ?? {
          version: 1,
          storageId: paths.storageId,
          accounts: entry
            ? {
                [entry.binding.kind === 'local'
                  ? entry.binding.rowId
                  : entry.binding.routeId]: entry,
              }
            : {},
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  }
  return { root, paths, subject, hooks, put }
}

function entry(subject: NativeLocalCredentialValidation): NativeRuntimeEntry {
  return { binding: subject.binding, credentialValidation: subject }
}

function retry(subject: NativeLocalCredentialValidation, nextRetryAt = 800) {
  return { subject, checkedAt: 200, nextRetryAt }
}

function refreshError(
  subject: NativeLocalCredentialValidation,
  fields: Partial<NativeLocalRefreshError> = {},
): NativeLocalRefreshError {
  return {
    message: 'synthetic provider detail that must never escape',
    checkedAt: 200,
    credentialFingerprint: subject.credentialFingerprint,
    nextRetryAt: 800,
    permanent: false,
    ...fields,
  }
}

async function snapshot(root: string) {
  const result: Record<string, { mode: number; bytes: string | null }> = {}
  for (const name of (await files.readdir(root, { recursive: true })).sort()) {
    const path = join(root, name)
    const info = await files.lstat(path)
    result[name] = {
      mode: info.mode,
      bytes: info.isFile()
        ? (await files.readFile(path)).toString('hex')
        : null,
    }
  }
  return result
}

test('admits exact known positive proof from a real runtime file', async () => {
  const f = await fixture()
  // These fixed values independently check fingerprintOf's 64-hex refresh
  // credential hash and tokenFingerprint's 16-hex access-token hash.
  expect(f.subject.credentialFingerprint).toBe(
    '008f37156dffc3a2d0fc5793e4115ced8dd87f9609aa0e14f11aa09f45daaf04',
  )
  expect(f.subject.version.accessFingerprint).toBe('270863a0169db796')
  await f.put(entry(f.subject))
  expect(await f.hooks.readAdmission(f.subject)).toEqual({
    status: 'proven',
    validation: f.subject,
  })
  expect(Object.keys(f.hooks).sort()).toEqual([
    'readAdmission',
    'readRestrictions',
  ])
})

test('missing proof and account projections never imply positive admission', async () => {
  const f = await fixture()
  expect(await f.hooks.readAdmission(f.subject)).toEqual({ status: 'unproven' })
  await f.put({
    binding: f.subject.binding,
    lastRefreshedAt: 100,
    quotaToken: f.subject.version.accessFingerprint,
    quotaCheckedAt: 100,
    profile: {
      tier: 'max',
      orgType: 'individual',
      checkedAt: 100,
      accountIdentity: accountA,
      providerAccountUuid: accountA,
      tokenFingerprint: f.subject.version.accessFingerprint,
    },
    prime: { count: 1, inputTokens: 2, outputTokens: 3, since: 0 },
    authLineageId: 'synthetic-adopted-lineage',
    primeAuthLineageRefreshTokenFingerprint: tokenFingerprint(material.refresh),
  })
  expect(await f.hooks.readAdmission(f.subject)).toEqual({ status: 'unproven' })
  expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual(
    allowed,
  )
})

const mismatches: Array<
  [
    string,
    (s: NativeLocalCredentialValidation) => NativeLocalCredentialValidation,
  ]
> = [
  [
    'storage',
    (s) => ({ ...s, binding: { ...s.binding, storageId: 'b'.repeat(64) } }),
  ],
  [
    'row',
    (s) => ({ ...s, binding: { ...s.binding, rowId: 'synthetic-row-B' } }),
  ],
  ['epoch', (s) => ({ ...s, binding: { ...s.binding, credentialEpoch: 2 } })],
  ['account', (s) => ({ ...s, binding: { ...s.binding, identity: accountB } })],
  [
    'full refresh lineage',
    (s) => ({
      ...s,
      credentialFingerprint: fingerprintOf({
        type: 'oauth',
        refresh: 'synthetic-refresh-B',
      }),
    }),
  ],
  [
    'access fingerprint',
    (s) => ({
      ...s,
      version: {
        ...s.version,
        accessFingerprint: tokenFingerprint('synthetic-access-B'),
      },
    }),
  ],
  ['expiry', (s) => ({ ...s, version: { ...s.version, expires: 1_001 } })],
  [
    'refresh timestamp',
    (s) => ({ ...s, version: { ...s.version, lastRefreshedAt: 101 } }),
  ],
  [
    'missing refresh timestamp',
    (s) => ({
      ...s,
      version: {
        accessFingerprint: s.version.accessFingerprint,
        expires: s.version.expires,
      },
    }),
  ],
]

for (const [name, change] of mismatches) {
  test(`positive proof rejects changed ${name}`, async () => {
    const f = await fixture()
    await f.put(entry(f.subject))
    expect(await f.hooks.readAdmission(change(f.subject))).toEqual({
      status: 'unproven',
    })
  })
  test(`validation retry rejects changed ${name}`, async () => {
    const f = await fixture()
    await f.put({
      binding: f.subject.binding,
      validationRetry: retry(f.subject),
    })
    expect(await f.hooks.readAdmission(change(f.subject))).toEqual({
      status: 'unproven',
    })
  })
}

test('proof and retry preserve absent versus zero timestamp in both directions', async () => {
  const f = await fixture()
  const absent = {
    ...f.subject,
    version: {
      accessFingerprint: f.subject.version.accessFingerprint,
      expires: 1_000,
    },
  }
  const zero = { ...absent, version: { ...absent.version, lastRefreshedAt: 0 } }
  for (const [stored, presented] of [
    [absent, zero],
    [zero, absent],
  ] as const) {
    await f.put(entry(stored))
    expect(await f.hooks.readAdmission(presented)).toEqual({
      status: 'unproven',
    })
    expect(await f.hooks.readAdmission(stored)).toEqual({
      status: 'proven',
      validation: stored,
    })
    await f.put({ binding: stored.binding, validationRetry: retry(stored) })
    expect(await f.hooks.readAdmission(presented)).toEqual({
      status: 'unproven',
    })
    expect(await f.hooks.readAdmission(stored)).toEqual({
      status: 'blocked',
      reason: 'validation-backoff',
    })
  }
})

for (const reason of [
  'local-mode-unavailable',
  'account-disabled',
  'quota-ineligible',
] as const) {
  test(`explicit external ${reason} policy blocks both hooks despite proof`, async () => {
    const seen: NativeRefreshSubject[] = []
    const gate = { status: 'blocked' as const, reason }
    const f = await fixture((s) => {
      seen.push(s)
      return gate
    })
    await f.put(entry(f.subject))
    expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual(
      gate,
    )
    expect(await f.hooks.readAdmission(f.subject)).toEqual(gate)
    expect(seen).toEqual([f.subject, f.subject])
  })
}

test('factory requires explicit general policy and rejects credential policy injection', async () => {
  const f = await fixture()
  expect(() =>
    Reflect.apply(createNativeLocalRuntimeReaders, undefined, [
      { paths: f.paths },
    ]),
  ).toThrow('Native local external policy gate is required')
  for (const gate of [
    undefined,
    { status: 'blocked', reason: 'refresh-backoff' },
    { status: 'blocked', reason: 'validation-backoff' },
    {
      status: 'allowed',
      credentialFingerprint: f.subject.credentialFingerprint,
    },
    {
      status: 'blocked',
      reason: 'quota-ineligible',
      credentialFingerprint: f.subject.credentialFingerprint,
    },
  ]) {
    const hooks: Pick<
      NativeRefreshHooks,
      'readRestrictions' | 'readAdmission'
    > = Reflect.apply(createNativeLocalRuntimeReaders, undefined, [
      { paths: f.paths, externalPolicy: () => gate },
    ])
    await expect(hooks.readRestrictions(f.subject)).rejects.toThrow(
      'Native local external policy result is invalid',
    )
    await expect(hooks.readAdmission(f.subject)).rejects.toThrow(
      'Native local external policy result is invalid',
    )
  }
})

test('external policy callback must accept sparse refresh subjects under strict TypeScript', async () => {
  const f = await fixture()
  const tsc = join(import.meta.dir, '../../../../node_modules/.bin/tsc')
  const config = join(f.root, 'tsconfig.json')
  const path = join(f.root, 'policy.ts')
  await files.writeFile(
    config,
    JSON.stringify({
      extends: join(import.meta.dir, '../../tsconfig.json'),
      files: ['policy.ts'],
      include: [],
    }),
  )
  const imports = `
    import { createNativeLocalRuntimeReaders, type NativeLocalRuntimeReadersOptions, type NativeLocalExternalPolicy } from ${JSON.stringify(join(import.meta.dir, '../native-local-runtime-readers.ts'))};
    import type { NativeRefreshSubject } from ${JSON.stringify(join(import.meta.dir, '../native-refresh-coordinator.ts'))};
    import type { NativeLocalCredentialValidation } from ${JSON.stringify(join(import.meta.dir, '../native-credential-validation.ts'))};
    import type { NativePoolPaths } from ${JSON.stringify(join(import.meta.dir, '../pool-paths.ts'))};
    declare const paths: NativePoolPaths;
  `
  const version = Bun.spawnSync([tsc, '--version'], {
    cwd: f.root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(version.exitCode).toBe(0)
  expect(version.stdout.toString().trim()).toBe('Version 7.0.2')
  console.log(version.stdout.toString().trim())
  await files.writeFile(
    path,
    `${imports}
    const broad = (subject: NativeRefreshSubject): NativeLocalExternalPolicy => {
      void subject;
      return { status: 'allowed' };
    };
    const options: NativeLocalRuntimeReadersOptions = { paths, externalPolicy: broad };
    createNativeLocalRuntimeReaders(options);
  `,
  )
  const positive = Bun.spawnSync([tsc, '-p', config, '--listFiles'], {
    cwd: f.root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(positive.exitCode).toBe(0)
  expect(positive.stderr.toString()).toBe('')
  const checked = positive.stdout.toString().trim().split('\n')
  expect(checked).toContain(path)
  expect(checked).toContain(
    join(import.meta.dir, '../native-local-runtime-readers.ts'),
  )
  console.log(
    `External policy broad callback: ${checked.length} actual source/type files checked, exit ${positive.exitCode}`,
  )
  await files.writeFile(
    path,
    `${imports}
    const narrow = (subject: NativeLocalCredentialValidation): NativeLocalExternalPolicy => {
      subject.binding.identity.toUpperCase();
      subject.version.expires.toFixed();
      return { status: 'allowed' };
    };
    const unsafe: NativeLocalRuntimeReadersOptions = { paths, externalPolicy: narrow };
    createNativeLocalRuntimeReaders({ paths, externalPolicy: narrow });
    void unsafe;
  `,
  )
  const negative = Bun.spawnSync([tsc, '-p', config], {
    cwd: f.root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const diagnostics = negative.stdout.toString() + negative.stderr.toString()
  console.log(
    `External policy narrow callback: ${tsc} -p ${config}, exit ${negative.exitCode}\n${diagnostics}`,
  )
  expect(negative.exitCode).toBe(1)
  expect(diagnostics).toContain('policy.ts')
  expect(diagnostics.match(/TS2322/g)).toHaveLength(2)
  expect(diagnostics).toContain('NativeRefreshSubject')
  expect(diagnostics).toContain('NativeLocalCredentialValidation')
})

test('restrictions echo captured partial subject and observe null zero and stale reset markers', async () => {
  const f = await fixture()
  const { identity: _identity, ...unknownBinding } = f.subject.binding
  const captured: NativeRefreshSubject = {
    binding: unknownBinding,
    credentialFingerprint: f.subject.credentialFingerprint,
    version: { lastRefreshedAt: 0 },
  }
  const before = structuredClone(captured)
  const empty = {
    refreshErrorClearedAt: null,
    quotaErrorClearedAt: null,
    quotaErrorGeneration: null,
  }
  expect(await f.hooks.readRestrictions(captured)).toEqual({
    restriction: allowed,
    context: { subject: captured, runtimeBinding: null, ...empty },
  })
  await f.put(entry(f.subject))
  expect((await f.hooks.readRestrictions(captured)).context).toEqual({
    subject: captured,
    runtimeBinding: f.subject.binding,
    ...empty,
  })
  for (const value of [0, 7]) {
    const observed = {
      ...f.subject.binding,
      credentialEpoch: 2,
      identity: accountB,
    }
    await f.put({
      binding: observed,
      refreshErrorClearedAt: value,
      quotaErrorClearedAt: value,
      quotaErrorGeneration: value,
    })
    expect((await f.hooks.readRestrictions(captured)).context).toEqual({
      subject: captured,
      runtimeBinding: observed,
      refreshErrorClearedAt: value,
      quotaErrorClearedAt: value,
      quotaErrorGeneration: value,
    })
  }
  expect(captured).toEqual(before)
  await f.put({
    binding: { ...f.subject.binding, rowId: 'synthetic-later-row' },
  })
  expect(
    (await f.hooks.readRestrictions(captured)).context.runtimeBinding,
  ).toBeNull()
})

test('native refresh errors require explicit full lineage never legacy hash aliases', async () => {
  const f = await fixture()
  const legacy = {
    message: 'invalid_grant raw provider detail',
    checkedAt: 200,
    nextRetryAt: 800,
    permanent: true,
  }
  expect(hashRefreshToken(material.refresh)).not.toBe(
    f.subject.credentialFingerprint,
  )
  for (const error of [
    legacy,
    { ...legacy, tokenHash: hashRefreshToken(material.refresh) },
    { ...legacy, tokenHash: f.subject.credentialFingerprint },
    { ...legacy, refreshTokenFingerprint: tokenFingerprint(material.refresh) },
    { ...legacy, credentialFingerprint: hashRefreshToken(material.refresh) },
    { ...legacy, credentialFingerprint: 'b'.repeat(64) },
  ]) {
    await f.put({ binding: f.subject.binding, lastRefreshError: error })
    expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual(
      allowed,
    )
    expect(await f.hooks.readAdmission(f.subject)).toEqual({
      status: 'unproven',
    })
  }
})

test('exact native error honors only stored retry and explicit permanent flag', async () => {
  const f = await fixture()
  for (const [fields, reason] of [
    [{ nextRetryAt: 800, permanent: false, status: 503 }, 'refresh-backoff'],
    [{ nextRetryAt: 0, permanent: true, status: 400 }, 'invalid-grant'],
  ] as const) {
    await f.put({
      ...entry(f.subject),
      lastRefreshError: refreshError(f.subject, fields),
    })
    expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual({
      status: 'blocked',
      reason,
      credentialFingerprint: f.subject.credentialFingerprint,
    })
    expect(await f.hooks.readAdmission(f.subject)).toEqual({
      status: 'blocked',
      reason,
    })
  }
  for (const fields of [
    { nextRetryAt: 499 },
    { nextRetryAt: 500 },
    { nextRetryAt: 0 },
    { nextRetryAt: 500, status: 400, permanent: false },
  ]) {
    await f.put({
      ...entry(f.subject),
      lastRefreshError: refreshError(f.subject, fields),
    })
    expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual(
      allowed,
    )
    expect(await f.hooks.readAdmission(f.subject)).toEqual({
      status: 'proven',
      validation: f.subject,
    })
  }
  await f.put({
    binding: f.subject.binding,
    lastRefreshError: {
      message: 'invalid_grant',
      checkedAt: 200,
      status: 400,
      credentialFingerprint: f.subject.credentialFingerprint,
    },
  })
  expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual(
    allowed,
  )
})

test('stale native error binding and credential rotation cannot latch replacements', async () => {
  const f = await fixture()
  for (const change of mismatches.slice(0, 5)) {
    await f.put({
      binding: f.subject.binding,
      lastRefreshError: refreshError(f.subject, { permanent: true }),
    })
    const changed = change[1](f.subject)
    expect((await f.hooks.readRestrictions(changed)).restriction).toEqual(
      allowed,
    )
    expect(await f.hooks.readAdmission(changed)).toEqual({ status: 'unproven' })
  }
  // Changing only the access fingerprint leaves the refresh credential unchanged,
  // so an error bound to that refresh credential still applies.
  await f.put({
    binding: f.subject.binding,
    lastRefreshError: refreshError(f.subject),
  })
  const changedAccess = mismatches[5]![1](f.subject)
  expect((await f.hooks.readRestrictions(changedAccess)).restriction).toEqual({
    status: 'blocked',
    reason: 'refresh-backoff',
    credentialFingerprint: f.subject.credentialFingerprint,
  })
  const { identity: _identity, ...unknown } = f.subject.binding
  const captured = { ...f.subject, binding: unknown }
  expect((await f.hooks.readRestrictions(captured)).restriction).toEqual(
    allowed,
  )
})

test('unproven matching validation retry fences admission but never refresh restrictions', async () => {
  const f = await fixture()
  await f.put({ binding: f.subject.binding, validationRetry: retry(f.subject) })
  expect(await f.hooks.readAdmission(f.subject)).toEqual({
    status: 'blocked',
    reason: 'validation-backoff',
  })
  expect((await f.hooks.readRestrictions(f.subject)).restriction).toEqual(
    allowed,
  )
})

test('due retry and expired material cannot inherit validation backoff', async () => {
  const f = await fixture()
  for (const due of [499, 500]) {
    await f.put({
      binding: f.subject.binding,
      validationRetry: retry(f.subject, due),
    })
    expect(await f.hooks.readAdmission(f.subject)).toEqual({
      status: 'unproven',
    })
  }
  for (const expires of [499, 500]) {
    const expired = { ...f.subject, version: { ...f.subject.version, expires } }
    await f.put({ binding: expired.binding, validationRetry: retry(expired) })
    expect(await f.hooks.readAdmission(expired)).toEqual({ status: 'unproven' })
    expect((await f.hooks.readRestrictions(expired)).restriction).toEqual(
      allowed,
    )
  }
  const changed = mismatches[5]![1](f.subject)
  await f.put({ ...entry(changed), validationRetry: retry(f.subject) })
  expect(await f.hooks.readAdmission(changed)).toEqual({
    status: 'proven',
    validation: changed,
  })
})

test('malformed mismatched and reset-cleared runtime files fail with redacted diagnostics', async () => {
  const f = await fixture()
  const secret = 'sk-ant-oat01-synthetic-secret-never-echo'
  const good = {
    version: 1,
    storageId: f.paths.storageId,
    accounts: { [f.subject.binding.rowId]: entry(f.subject) },
  }
  for (const value of [
    { ...good, version: 2 },
    { ...good, storageId: 'b'.repeat(64) },
    { ...good, secret },
    {
      ...good,
      accounts: {
        [f.subject.binding.rowId]: {
          binding: {
            kind: 'custody',
            storageId: f.paths.storageId,
            routeId: f.subject.binding.rowId,
            credentialId: 'synthetic-custody-credential',
            accountIdentity: accountA,
            recordVersion: 0,
          },
        },
      },
    },
    {
      ...good,
      accounts: {
        [f.subject.binding.rowId]: {
          binding: { ...f.subject.binding, rowId: 'different-row' },
        },
      },
    },
    {
      ...good,
      accounts: {
        [f.subject.binding.rowId]: {
          binding: f.subject.binding,
          credentialValidation: { binding: f.subject.binding },
        },
      },
    },
    {
      ...good,
      accounts: {
        [f.subject.binding.rowId]: {
          binding: f.subject.binding,
          lastRefreshError: refreshError(f.subject, {
            credentialFingerprint: secret,
          }),
        },
      },
    },
    {
      ...good,
      accounts: {
        [f.subject.binding.rowId]: {
          binding: f.subject.binding,
          lastRefreshError: refreshError(f.subject),
          refreshErrorClearedAt: 200,
        },
      },
    },
  ]) {
    await f.put(undefined, value)
    const before = await snapshot(f.root)
    for (const read of [f.hooks.readRestrictions, f.hooks.readAdmission]) {
      await expect(read(f.subject)).rejects.toBeInstanceOf(NativeRuntimeError)
      await expect(read(f.subject)).rejects.toMatchObject({
        code: 'invalid-runtime',
        message: 'Anthropic runtime state is invalid',
      })
    }
    expect(await snapshot(f.root)).toEqual(before)
  }
  await files.writeFile(f.paths.runtime, `{ "secret": "${secret}",`, {
    mode: 0o600,
  })
  await expect(f.hooks.readAdmission(f.subject)).rejects.toMatchObject({
    code: 'invalid-runtime',
    message: 'Anthropic runtime state is invalid',
  })
  await f.put(entry(f.subject))
  await files.chmod(f.paths.runtime, 0o644)
  await expect(f.hooks.readRestrictions(f.subject)).rejects.toMatchObject({
    code: 'unsafe-runtime',
    message: 'Anthropic runtime file is not owner-only regular storage',
  })
})

test('reader calls leave files byte-identical with no mutation locks or provider HTTP', async () => {
  const f = await fixture()
  for (const path of [
    f.paths.config,
    f.paths.state,
    f.paths.legacyConfig,
    f.paths.legacyState,
    f.paths.journal,
    f.paths.roster,
  ])
    await files.writeFile(
      path,
      'opaque sentinel, not a readable credential store',
      { mode: 0o600 },
    )
  await f.put(entry(f.subject))
  const before = await snapshot(f.root)
  const write = spyOn(files, 'writeFile')
  const rename = spyOn(files, 'rename')
  const mkdir = spyOn(files, 'mkdir')
  const rm = spyOn(files, 'rm')
  const open = spyOn(files, 'open')
  const lock = spyOn(lockFs, 'withLock')
  const refreshLock = spyOn(lockFs, 'acquireRefreshFileLock')
  const pool = spyOn(pools, 'createNativePoolStore')
  const provider = spyOn(auth, 'refreshClaudeOAuthToken')
  const bootstrap = spyOn(identity, 'resolveClaudeCodeIdentity')
  const http = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  try {
    await f.hooks.readRestrictions(f.subject)
    await f.hooks.readAdmission(f.subject)
    expect(await snapshot(f.root)).toEqual(before)
    for (const observation of [
      write,
      rename,
      mkdir,
      rm,
      lock,
      refreshLock,
      pool,
      provider,
      bootstrap,
      http,
    ])
      expect(observation).toHaveBeenCalledTimes(0)
    expect(open.mock.calls).toHaveLength(2)
    expect(
      open.mock.calls.every(
        (call) => call[1] === (constants.O_RDONLY | constants.O_NOFOLLOW),
      ),
    ).toBe(true)
  } finally {
    for (const observation of [
      write,
      rename,
      mkdir,
      rm,
      open,
      lock,
      refreshLock,
      pool,
      provider,
      bootstrap,
      http,
    ])
      observation.mockRestore()
  }
})

async function coordinatorFixture(expires = 1_000) {
  const f = await fixture()
  const store = pools.createNativePoolStore({
    paths: f.paths,
    now: () => now,
    quota: { validate: () => true, merge: (_, observation) => observation },
  })
  await store.add({
    id: f.subject.binding.rowId,
    identity: accountA,
    credential: { ...material, expires },
  })
  const read = await store.read()
  if (read.status !== 'ready')
    throw new Error('Native test pool is unavailable')
  const row = read.rows[0]!
  // Store.add records lastRefreshedAt from its current clock rather than copying
  // the timestamp supplied with the incoming credential.
  expect(row.credential).toMatchObject({
    ...material,
    expires,
    lastRefreshedAt: now,
  })
  const subject = {
    ...f.subject,
    binding: { ...f.subject.binding, credentialEpoch: row.credentialEpoch! },
    version: { ...f.subject.version, expires, lastRefreshedAt: now },
  }
  return { ...f, subject, store }
}

test('exact positive proof survives coexisting validation retry without provider work', async () => {
  const f = await coordinatorFixture()
  await f.put({ ...entry(f.subject), validationRetry: retry(f.subject) })
  let providers = 0
  let lookups = 0
  const observations: NativeRefreshObservation[] = []
  const coordinator = createNativeRefreshCoordinator({
    paths: f.paths,
    now: () => now,
    quota: { validate: () => true, merge: (_, observation) => observation },
    ...f.hooks,
    refreshToken: async () => {
      providers++
      return { ...material, expiresIn: 3_600 }
    },
    resolveIdentity: async () => {
      lookups++
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: accountA,
      }
    },
    reconcile: async (observation) => {
      observations.push(observation)
    },
  })
  const before = await snapshot(f.root)
  expect(await f.hooks.readAdmission(f.subject)).toEqual({
    status: 'proven',
    validation: f.subject,
  })
  expect(
    await coordinator.authorize({
      mode: 'local',
      intent: 'serve',
      binding: f.subject.binding,
    }),
  ).toMatchObject({
    status: 'usable',
    source: 'current',
    access: material.access,
    validation: f.subject,
  })
  expect([providers, lookups, observations.length]).toEqual([0, 0, 0])
  expect(await snapshot(f.root)).toEqual(before)
})

test('actual coordinator admits only real current proof without provider work', async () => {
  const f = await coordinatorFixture()
  await f.put(entry(f.subject))
  let providers = 0
  let lookups = 0
  const observations: NativeRefreshObservation[] = []
  const coordinator = createNativeRefreshCoordinator({
    paths: f.paths,
    now: () => now,
    quota: { validate: () => true, merge: (_, observation) => observation },
    ...f.hooks,
    refreshToken: async () => {
      providers++
      return { ...material, expiresIn: 3_600 }
    },
    resolveIdentity: async () => {
      lookups++
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: accountA as identity.ProviderAccountUuid,
      }
    },
    reconcile: async (observation) => {
      observations.push(observation)
    },
  })
  const before = await snapshot(f.root)
  const result = await coordinator.authorize({
    mode: 'local',
    intent: 'serve',
    binding: f.subject.binding,
  })
  expect(result).toMatchObject({
    status: 'usable',
    source: 'current',
    access: material.access,
    validation: f.subject,
  })
  expect([providers, lookups, observations.length]).toEqual([0, 0, 0])
  expect(await snapshot(f.root)).toEqual(before)
  await f.put({ binding: f.subject.binding, validationRetry: retry(f.subject) })
  expect(
    await coordinator.authorize({
      mode: 'local',
      intent: 'serve',
      binding: f.subject.binding,
    }),
  ).toEqual({
    status: 'refused',
    reason: 'validation-backoff',
    persisted: false,
  })
  expect([providers, lookups, observations.length]).toEqual([0, 0, 0])
})

test('actual coordinator account lookup cannot admit missing runtime proof', async () => {
  const f = await coordinatorFixture()
  const observations: NativeRefreshObservation[] = []
  let providers = 0
  let lookups = 0
  const coordinator = createNativeRefreshCoordinator({
    paths: f.paths,
    now: () => now,
    quota: { validate: () => true, merge: (_, observation) => observation },
    ...f.hooks,
    refreshToken: async () => {
      providers++
      return { ...material, expiresIn: 3_600 }
    },
    resolveIdentity: async () => {
      lookups++
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: accountA,
      }
    },
    reconcile: async (observation) => {
      observations.push(observation)
    },
  })
  expect(
    await coordinator.authorize({
      mode: 'local',
      intent: 'serve',
      binding: f.subject.binding,
    }),
  ).toEqual({ status: 'refused', reason: 'proof-missing', persisted: false })
  expect([providers, lookups]).toEqual([0, 1])
  expect(observations.map((o) => o.status)).toEqual(['validation-observed'])
  expect(
    (await files.readdir(f.root)).includes('anthropic-auth-native-state.json'),
  ).toBe(false)
})

for (const recovery of ['expired', 'rejected'] as const) {
  test(`actual coordinator can refresh ${recovery} material despite absent proof and validation retry`, async () => {
    const f = await coordinatorFixture(recovery === 'expired' ? now : 1_000)
    await f.put({
      binding: f.subject.binding,
      validationRetry: retry(f.subject),
    })
    const observations: NativeRefreshObservation[] = []
    let providers = 0
    let lookups = 0
    let reads = 0
    const coordinator = createNativeRefreshCoordinator({
      paths: f.paths,
      now: () => now,
      quota: { validate: () => true, merge: (_, observation) => observation },
      readRestrictions: async (subject) => {
        const before = await snapshot(f.root)
        const policy = await f.hooks.readRestrictions(subject)
        expect(await snapshot(f.root)).toEqual(before)
        reads++
        return policy
      },
      readAdmission: async (subject) => {
        const before = await snapshot(f.root)
        const admission = await f.hooks.readAdmission(subject)
        expect(await snapshot(f.root)).toEqual(before)
        return admission
      },
      refreshToken: async () => {
        providers++
        return {
          ...material,
          access: 'synthetic-new-access',
          refresh: 'synthetic-new-refresh',
          expires: 2_000,
          expiresIn: 3_600,
        }
      },
      resolveIdentity: async () => {
        lookups++
        return {
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
          accountUuid: accountA as identity.ProviderAccountUuid,
        }
      },
      reconcile: async (observation) => {
        observations.push(observation)
      },
    })
    const runtimeBefore = await files.readFile(f.paths.runtime, 'utf8')
    const result = await coordinator.authorize({
      mode: 'local',
      intent: 'serve',
      binding: f.subject.binding,
      ...(recovery === 'rejected'
        ? { rejectedAccessToken: material.access }
        : {}),
    })
    // The runtime readers do not write validation evidence for the rotated
    // credential. A successful exchange alone must not authorize its use.
    expect(result).toEqual({
      status: 'refused',
      reason: 'proof-missing',
      persisted: true,
    })
    expect([providers, lookups]).toEqual([1, 1])
    expect(reads).toBeGreaterThan(0)
    expect(observations.map((o) => o.status)).toEqual(['persisted'])
    expect(await files.readFile(f.paths.runtime, 'utf8')).toBe(runtimeBefore)
    const read = await f.store.read()
    if (read.status !== 'ready')
      throw new Error('Native test pool is unavailable')
    expect(read.rows[0]!.credential).toMatchObject({
      type: 'oauth',
      access: 'synthetic-new-access',
    })
  })
}
