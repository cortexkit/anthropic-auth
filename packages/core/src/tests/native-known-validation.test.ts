import { expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lockPathFor } from '@cortexkit/common-auth/fs'
import { fingerprintOf, type PoolRow } from '@cortexkit/common-auth/store'

import type { ProviderAccountUuid } from '../claude-code.ts'
import {
  type NativeLocalCredentialValidation,
  nativeLocalCredentialValidationMatches,
} from '../native-credential-validation.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshObservation,
  type NativeRefreshSubject,
} from '../native-refresh-coordinator.ts'
import {
  isNativeRuntimeStagingName,
  type NativeRuntimeEntry,
  publishNativeLocalCredentialValidation,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'
import { captureNativeLocalPoolBinding } from '../pool-binding.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite, TestLifetime } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const otherUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const credential = {
  type: 'oauth' as const,
  access: 'synthetic-known-access',
  refresh: 'synthetic-known-refresh',
  expires: 4_000_000_000_000,
}

function subjectOf(
  paths: Awaited<ReturnType<typeof resolveNativePoolPaths>>,
  row: PoolRow,
): NativeLocalCredentialValidation {
  const c = row.credential
  const binding = captureNativeLocalPoolBinding(paths, row)
  if (c?.type !== 'oauth' || !c.access || !c.expires || !binding.identity)
    throw new Error('Incomplete fixture material')
  return {
    binding: { ...binding, identity: binding.identity },
    credentialFingerprint: fingerprintOf(c),
    version: {
      accessFingerprint: tokenFingerprint(c.access),
      expires: c.expires,
      ...(Object.hasOwn(c, 'lastRefreshedAt')
        ? { lastRefreshedAt: c.lastRefreshedAt }
        : {}),
    },
  }
}

async function fixture(
  metadata: Partial<NativeRuntimeEntry> = {},
  missing = false,
) {
  const parent = new URL(
    '../../../../node_modules/.cache/native-known-validation-evidence/',
    import.meta.url,
  )
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent.pathname, 'fixture-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'config.json'),
    join(root, 'state.json'),
  )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  await store.add({ id: 'row', identity: uuid, credential })
  // Adding an account sets its refresh timestamp. Remove that timestamp here so
  // absence-versus-zero checks test field presence, not two numeric values.
  // This timestamp is separate from the credential's integrity stamp.
  const initial = JSON.parse(await readFile(paths.state, 'utf8'))
  delete initial.accounts.row.lastRefreshedAt
  await writeFile(paths.state, JSON.stringify(initial), { mode: 0o600 })
  const read = await store.read()
  if (read.status !== 'ready' || !read.rows[0])
    throw new Error('Missing fixture row')
  const subject = subjectOf(paths, read.rows[0])
  const runtime = await updateNativeRuntime(
    paths.runtime,
    paths.storageId,
    () => ({
      version: 1,
      storageId: paths.storageId,
      accounts: {
        ...(!missing ? { row: { binding: subject.binding, ...metadata } } : {}),
        unrelated: {
          binding: {
            ...subject.binding,
            rowId: 'unrelated',
            identity: otherUuid,
          },
          lastUsed: 5,
        },
      },
    }),
  )
  const event: NativeRefreshObservation = {
    status: 'validation-observed',
    binding: subject.binding,
    identity: uuid,
    bootstrap: 'resolved',
    handoff: 'not-needed',
    attempt: 1,
    credentialFingerprint: subject.credentialFingerprint,
    credentialVersion: subject.version,
    context: {
      subject,
      runtimeBinding: missing ? null : subject.binding,
      refreshErrorClearedAt: metadata.refreshErrorClearedAt ?? null,
      quotaErrorClearedAt: metadata.quotaErrorClearedAt ?? null,
      quotaErrorGeneration: metadata.quotaErrorGeneration ?? null,
    },
  }
  return { root, paths, store, subject, event, runtime }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function refused(
  f: Fixture,
  event: unknown = f.event,
  code = 'publication-refused',
  publisher = publishNativeLocalCredentialValidation,
) {
  const before = await readFile(f.paths.runtime, 'utf8')
  let error: unknown
  try {
    await publisher(f.paths, event as NativeRefreshObservation)
  } catch (caught) {
    error = caught
  }
  // Verify unchanged runtime bytes first; the error code alone cannot prove that
  // a refused write left the account state intact.
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
  expect(
    (await readdir(f.root)).filter((name) =>
      isNativeRuntimeStagingName(f.paths.runtime, name),
    ),
  ).toEqual([])
  expect(error).toMatchObject({ name: 'NativeRuntimeError', code })
  expect(String(error)).not.toContain(credential.access)
  expect(String(error)).not.toContain(credential.refresh)
}

async function savedSuccessor(f: Fixture): Promise<NativeRefreshObservation> {
  await f.store.rotate('row', {
    ...credential,
    access: 'synthetic-successor-access',
    refresh: 'synthetic-successor-refresh',
  })
  const read = await f.store.read()
  if (read.status !== 'ready' || !read.rows[0])
    throw new Error('Missing successor')
  const successor = subjectOf(f.paths, read.rows[0])
  expect(successor.binding).toEqual(f.subject.binding)
  return {
    ...f.event,
    status: 'persisted',
    successorFingerprint: successor.credentialFingerprint,
    successorVersion: successor.version,
    committed: {
      credentialFingerprint: successor.credentialFingerprint,
      version: successor.version,
    },
  }
}

test('known publication healthy positive control', async () => {
  const f = await fixture()
  const next = await publishNativeLocalCredentialValidation(f.paths, f.event)
  expect(next.accounts.row).toEqual({
    binding: f.subject.binding,
    credentialValidation: f.subject,
  })
  const read = await f.store.read()
  expect(
    read.status === 'ready' &&
      nativeLocalCredentialValidationMatches(
        next.accounts.row?.credentialValidation,
        f.subject.binding,
        read.rows[0]?.credential,
      ),
  ).toBe(true)
  expect(await readNativeRuntime(f.paths.runtime, f.paths.storageId)).toEqual({
    status: 'ready',
    state: next,
  })
})

test('known publication preserves every unrelated metadata field and replaces only proof', async () => {
  const f = await fixture({
    lastUsed: 1,
    lastRefreshedAt: 2,
    lastRefreshError: {
      message: 'old refresh',
      checkedAt: 11,
      accountIdentity: uuid,
    },
    refreshErrorClearedAt: 0,
    lastQuotaRefreshError: {
      message: 'old quota',
      checkedAt: 13,
      accountIdentity: uuid,
    },
    quotaErrorClearedAt: 3,
    quotaErrorGeneration: 7,
    refreshLeaseId: 'old-lease',
    refreshLeaseUntil: 99,
    refreshLeaseTokenHash: 'a'.repeat(64),
    profile: {
      tier: 'max',
      orgType: 'team',
      checkedAt: 5,
      providerAccountUuid: uuid as ProviderAccountUuid,
    },
    prime: { count: 1, inputTokens: 2, outputTokens: 3, since: 4 },
    authLineageId: 'old-lineage',
    primeAuthLineageRefreshTokenFingerprint: tokenFingerprint('old-refresh'),
    quotaCheckedAt: 6,
    quotaToken: tokenFingerprint('old-access'),
  })
  const oldProof = { ...f.subject, credentialFingerprint: 'b'.repeat(64) }
  await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
    const old = current.accounts.row
    if (!old) throw new Error('Missing metadata')
    old.credentialValidation = oldProof
    old.validationRetry = { subject: oldProof, checkedAt: 20, nextRetryAt: 40 }
    return current
  })
  const before = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  if (before.status !== 'ready' || !before.state.accounts.row)
    throw new Error('Missing runtime')
  const event = await savedSuccessor(f)
  const next = await publishNativeLocalCredentialValidation(f.paths, event)
  if (!next.accounts.row) throw new Error('Missing published metadata')
  expect<NativeRuntimeEntry>({
    ...next.accounts.row,
    credentialValidation: oldProof,
  }).toEqual(before.state.accounts.row)
  expect(next.accounts.unrelated).toEqual(before.state.accounts.unrelated)
  expect(Object.keys(next.accounts)).toEqual(['row', 'unrelated'])
  const read = await f.store.read()
  expect(
    read.status === 'ready' &&
      nativeLocalCredentialValidationMatches(
        next.accounts.row?.credentialValidation,
        f.subject.binding,
        read.rows[0]?.credential,
      ),
  ).toBe(true)
  expect(next.accounts.row?.credentialValidation).not.toEqual(f.subject)
})

test('known publication creates only proof for genuinely missing metadata including absent runtime', async () => {
  for (const absentRuntime of [false, true]) {
    const f = await fixture({}, true)
    if (absentRuntime) await rm(f.paths.runtime)
    const next = await publishNativeLocalCredentialValidation(f.paths, f.event)
    expect(next.accounts.row).toEqual({
      binding: f.subject.binding,
      credentialValidation: f.subject,
    })
    expect(next.accounts.unrelated).toEqual(
      absentRuntime ? undefined : f.runtime.accounts.unrelated,
    )
  }
})

test('known publication persisted proof uses saved successor and permits sparse original dispatch', async () => {
  for (const version of [
    {},
    { accessFingerprint: undefined, expires: undefined },
  ]) {
    const f = await fixture()
    const event = await savedSuccessor(f)
    if (!event.context) throw new Error('Missing context')
    event.credentialVersion = version
    event.context = { ...event.context, subject: { ...f.subject, version } }
    const next = await publishNativeLocalCredentialValidation(f.paths, event)
    const read = await f.store.read()
    expect(
      read.status === 'ready' &&
        nativeLocalCredentialValidationMatches(
          next.accounts.row?.credentialValidation,
          f.subject.binding,
          read.rows[0]?.credential,
        ),
    ).toBe(true)
    expect(
      next.accounts.row?.credentialValidation?.credentialFingerprint,
    ).not.toBe(f.subject.credentialFingerprint)
  }
})

test('known publication refuses ineligible incomplete and incoherent observations', async () => {
  const f = await fixture()
  const base = f.event
  const negatives: unknown[] = [
    null,
    {},
    ...[
      'adopted',
      'failed',
      'refused',
      'identity-contradicted',
      'cancelled',
    ].map((status) => ({ ...base, status })),
    ...['failed', 'unavailable', undefined].map((bootstrap) => ({
      ...base,
      bootstrap,
      handoff: 'skipped-cancelled',
    })),
    ...[undefined, '', 'not-a-uuid', otherUuid].map((identity) => ({
      ...base,
      identity,
    })),
    { ...base, context: undefined },
    { ...base, credentialFingerprint: undefined },
    { ...base, credentialVersion: {} },
    { ...base, credentialVersion: { ...f.subject.version, expires: 0 } },
    { ...base, binding: { ...base.binding, identity: undefined } },
  ]
  for (const subject of [
    { ...f.subject, credentialFingerprint: 'a'.repeat(64) },
    { ...f.subject, binding: { ...f.subject.binding, identity: otherUuid } },
    { ...f.subject, version: {} },
    { ...f.subject, version: { ...f.subject.version, lastRefreshedAt: 0 } },
  ])
    negatives.push({ ...base, context: { ...base.context, subject } })
  for (const event of negatives) await refused(f, event)
})

test('known publication refuses incoherent committed successor and sparse successor material', async () => {
  const f = await fixture()
  const event = await savedSuccessor(f)
  if (event.status !== 'persisted')
    throw new Error('Expected persisted fixture')
  for (const changed of [
    { successorFingerprint: f.subject.credentialFingerprint },
    { successorVersion: f.subject.version },
    { committed: undefined },
    { successorVersion: {} },
    {
      committed: {
        credentialFingerprint: event.successorFingerprint,
        version: {},
      },
    },
    {
      committed: {
        ...event.committed,
        credentialFingerprint: f.subject.credentialFingerprint,
      },
    },
    { committed: { ...event.committed, version: f.subject.version } },
    { committed: { ...event.committed, extra: credential.access } },
  ])
    await refused(f, { ...event, ...changed })
})

test('known publication exact matcher rejects refresh access expiry and timestamp presence mismatches', async () => {
  for (const variant of [
    'refresh',
    'access',
    'expires',
    'stamp-zero',
    'stamp-value',
    'stamp-absent',
  ]) {
    const f = await fixture()
    const event = structuredClone(f.event)
    const version = { ...f.subject.version }
    expect(Object.hasOwn(version, 'lastRefreshedAt')).toBe(false)
    if (variant === 'refresh')
      event.credentialFingerprint = fingerprintOf({
        type: 'oauth',
        refresh: 'other-refresh',
      })
    if (variant === 'access')
      version.accessFingerprint = tokenFingerprint('other-access')
    if (variant === 'expires') version.expires--
    if (variant === 'stamp-zero') version.lastRefreshedAt = 0
    if (variant === 'stamp-value') version.lastRefreshedAt = 10
    if (variant === 'stamp-absent') {
      const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
      state.accounts.row.lastRefreshedAt = 0
      await writeFile(f.paths.state, JSON.stringify(state), { mode: 0o600 })
      const read = await f.store.read()
      const material =
        read.status === 'ready' ? read.rows[0]?.credential : undefined
      if (material?.type !== 'oauth')
        throw new Error('Missing timestamp fixture')
      expect(Object.hasOwn(material, 'lastRefreshedAt')).toBe(true)
      expect(material.lastRefreshedAt).toBe(0)
    }
    event.credentialVersion = version
    event.context = {
      ...f.event.context,
      subject: {
        ...f.subject,
        credentialFingerprint: event.credentialFingerprint ?? '',
        version,
      },
    }
    await refused(f, event)
  }
})

test('known publication refuses changed row storage epoch identity kind and unbound state', async () => {
  for (const variant of [
    'epoch',
    'identity',
    'missing',
    'kind',
    'unbound',
    'storage',
    'row',
  ]) {
    const f = await fixture()
    if (variant === 'epoch')
      await f.store.replace('row', credential, { identity: uuid })
    if (variant === 'identity')
      await f.store.replace('row', credential, { identity: otherUuid })
    if (variant === 'missing') await f.store.remove('row')
    if (variant === 'kind') {
      const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
      config.accounts[0].type = 'api'
      await writeFile(f.paths.config, JSON.stringify(config), { mode: 0o600 })
    }
    if (variant === 'unbound') {
      const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
      state.accounts.row.access = 'unstamped-access'
      await writeFile(f.paths.state, JSON.stringify(state), { mode: 0o600 })
    }
    let event = f.event
    if (variant === 'storage' || variant === 'row') {
      const binding = {
        ...f.subject.binding,
        ...(variant === 'storage'
          ? { storageId: 'b'.repeat(64) }
          : { rowId: 'elsewhere' }),
      }
      event = {
        ...event,
        binding,
        context: {
          ...f.event.context,
          runtimeBinding: binding,
          subject: { ...f.subject, binding },
        },
      }
    }
    await refused(f, event)
  }
})

test('known publication refuses captured reset context drift', async () => {
  const f = await fixture({
    refreshErrorClearedAt: 3,
    quotaErrorClearedAt: 5,
    quotaErrorGeneration: 7,
  })
  await refused(f, {
    ...f.event,
    context: { ...f.event.context, refreshErrorClearedAt: 2 },
  })
})

for (const key of [
  'refreshErrorClearedAt',
  'quotaErrorClearedAt',
  'quotaErrorGeneration',
]) {
  test(`known publication keeps null zero and safe ${key} semantics`, async () => {
    for (const [captured, current] of [
      [null, 0],
      [0, null],
      [1, 2],
    ]) {
      const f = await fixture(current === null ? {} : { [key]: current })
      await refused(f, {
        ...f.event,
        context: { ...f.event.context, [key]: captured },
      })
    }
    for (const invalid of [0.5, -1, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const f = await fixture()
      await refused(f, {
        ...f.event,
        context: { ...f.event.context, [key]: invalid },
      })
    }
    const missing = await fixture({}, true)
    await refused(missing, {
      ...missing.event,
      context: { ...missing.event.context, [key]: 0 },
    })
  })
}
test('known publication preserves recorded zero floors and generation', async () => {
  const f = await fixture({
    refreshErrorClearedAt: 0,
    quotaErrorClearedAt: 0,
    quotaErrorGeneration: 0,
  })
  const next = await publishNativeLocalCredentialValidation(f.paths, f.event)
  if (!f.runtime.accounts.row) throw new Error('Missing metadata')
  expect(next.accounts.row).toEqual({
    ...f.runtime.accounts.row,
    credentialValidation: f.subject,
  })
})

test('known publication rejects unknown custody retargeted and changed runtime predecessors', async () => {
  for (const binding of [
    { identity: undefined },
    { identity: otherUuid },
    { credentialEpoch: 2 },
    {
      kind: 'custody',
      storageId: '',
      routeId: 'row',
      credentialId: 'cred',
      accountIdentity: uuid,
      recordVersion: 1,
    },
  ]) {
    const f = await fixture()
    const predecessor =
      binding.kind === 'custody'
        ? { ...binding, storageId: f.paths.storageId }
        : { ...f.subject.binding, ...binding }
    const state = {
      ...f.runtime,
      accounts: {
        ...f.runtime.accounts,
        row: { binding: predecessor, lastUsed: 9 },
      },
    }
    await writeFile(f.paths.runtime, JSON.stringify(state), { mode: 0o600 })
    await refused(f)
    // Rebuilding context from current state must not let the known-account writer
    // publish an account UUID for the first time or change an existing UUID.
    await refused(f, {
      ...f.event,
      context: { ...f.event.context, runtimeBinding: predecessor },
    })
  }
  const f = await fixture()
  for (const changed of [
    { rowId: 'elsewhere' },
    { storageId: 'b'.repeat(64) },
    { credentialEpoch: 2 },
    { identity: otherUuid },
  ])
    await refused(f, {
      ...f.event,
      context: {
        ...f.event.context,
        runtimeBinding: { ...f.subject.binding, ...changed },
      },
    })
  await refused(f, {
    ...f.event,
    context: { ...f.event.context, runtimeBinding: null },
  })
  await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
    delete current.accounts.row
    return current
  })
  await refused(f)
})

for (const path of ['config', 'state', 'runtime'] as const) {
  test(`known publication strict decoder refuses malformed ${path}`, async () => {
    const f = await fixture()
    await writeFile(f.paths[path], '{"secret":"synthetic-known-refresh",', {
      mode: 0o600,
    })
    await refused(
      f,
      f.event,
      path === 'runtime' ? 'invalid-runtime' : 'publication-refused',
    )
  })
}
for (const metadata of [
  { credentialValidation: {} },
  { validationRetry: {} },
  { quota: {} },
  {
    lastRefreshError: {
      message: 'wrong account',
      checkedAt: 5,
      accountIdentity: otherUuid,
    },
  },
  {
    profile: {
      tier: 'max',
      orgType: 'team',
      checkedAt: 5,
      providerAccountUuid: otherUuid,
    },
  },
  { profileToken: tokenFingerprint('old') },
  { quotaErrorGeneration: -1 },
]) {
  test(`known publication strict decoder refuses mismatched ${Object.keys(metadata)[0]} metadata`, async () => {
    const f = await fixture()
    await writeFile(
      f.paths.runtime,
      JSON.stringify({
        ...f.runtime,
        accounts: {
          ...f.runtime.accounts,
          row: { binding: f.subject.binding, ...metadata },
        },
      }),
      { mode: 0o600 },
    )
    await refused(f, f.event, 'invalid-runtime')
  })
}

test('known publication refuses laundering valid proof and retry schemas with mismatched bindings', async () => {
  for (const field of ['credentialValidation', 'validationRetry']) {
    const f = await fixture()
    const wrong = {
      ...f.subject,
      binding: { ...f.subject.binding, identity: otherUuid },
    }
    const metadata =
      field === 'credentialValidation'
        ? wrong
        : { subject: wrong, checkedAt: 5, nextRetryAt: 10 }
    await writeFile(
      f.paths.runtime,
      JSON.stringify({
        ...f.runtime,
        accounts: {
          ...f.runtime.accounts,
          row: { binding: f.subject.binding, [field]: metadata },
        },
      }),
      { mode: 0o600 },
    )
    await refused(f, f.event, 'invalid-runtime')
  }
})

test('known publication disabled bound rows get proof without enabling eligibility', async () => {
  const f = await fixture()
  await f.store.disable('row', 'synthetic-disable')
  const before = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  const next = await publishNativeLocalCredentialValidation(f.paths, f.event)
  expect(next.accounts.row?.credentialValidation).toEqual(f.subject)
  const read = await f.store.read()
  expect(read.status === 'ready' && read.rows[0]?.enabled).toBe(false)
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(before)
})

// Modified copies of the runtime modules observe the installed file locks.
// The copies add no safety checks and do not replace Bun's module registry.
async function instrumented(f: Fixture) {
  const directory = join(f.root, 'instrumentation')
  await mkdir(directory)
  const sourcePath = new URL('../native-runtime.ts', import.meta.url)
  let source = await readFile(sourcePath, 'utf8')
  source = source.replace(
    /from '(\.\/[^']+)'/g,
    (_match, relative: string) =>
      `from '${new URL(relative, sourcePath).href}'`,
  )
  source = source.replace("from 'node:fs/promises'", "from './controls.ts'")
  source = source.replace(
    "from '@cortexkit/common-auth/fs'",
    "from './controls.ts'",
  )
  source = source.replace(
    "from '@cortexkit/common-auth/store'",
    `from '${import.meta.resolve('@cortexkit/common-auth/store')}'`,
  )
  source = source.replace(
    `from '${new URL('../pool-store.ts', import.meta.url).href}'`,
    "from './controls.ts'",
  )
  await writeFile(join(directory, 'runtime.ts'), source)
  await writeFile(
    join(directory, 'controls.ts'),
    `
import * as fs from 'node:fs/promises';
import { withLock as realLock } from ${JSON.stringify(import.meta.resolve('@cortexkit/common-auth/fs'))};
import { createNativePoolStore as realStore, nativePoolStoreLocks } from ${JSON.stringify(new URL('../pool-store.ts', import.meta.url).href)};
export { nativePoolStoreLocks };
export const events = []; export const held = new Set(); export const heldAtRenames = [];
export let reads = 0; export let renames = 0; export let forbidden = 0;
export const control = { afterSync: async () => {}, afterAcquire: async () => {} };
export const { lstat, mkdir, rm } = fs;
export async function open(...args) {
  const file = await fs.open(...args);
  if (args[1] !== 'wx') return file;
  return new Proxy(file, { get(target, key) {
    if (key === 'sync') return async () => { await target.sync(); await control.afterSync(); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  }});
}
export async function rename(...args) {
  events.push('rename'); renames++; heldAtRenames.push([...held]); await fs.rename(...args);
}
export async function withLock(path, options, callback) {
  return realLock(path, options, async lock => {
    events.push('acquire:' + options.name); held.add(options.name);
    try { await control.afterAcquire(options.name); return await callback({ assertOwned: async () => { events.push('assert:' + options.name); await lock.assertOwned(); } }); }
    finally { held.delete(options.name); events.push('release:' + options.name); }
  });
}
export function createNativePoolStore(options) {
  const store = realStore(options);
  return new Proxy(store, { get(target, key) {
    if (key === 'read') return async () => { reads++; events.push('read'); return target.read(); };
    forbidden++; throw new Error('Only strict read allowed');
  }});
}
`,
  )
  const runtime: typeof import('../native-runtime.ts') = await import(
    pathToFileURL(join(directory, 'runtime.ts')).href
  )
  const controls: {
    events: string[]
    held: Set<string>
    heldAtRenames: string[][]
    reads: number
    renames: number
    forbidden: number
    control: {
      afterSync: () => Promise<void>
      afterAcquire: (name: string) => Promise<void>
    }
  } = await import(pathToFileURL(join(directory, 'controls.ts')).href)
  return { runtime, controls }
}

test('known publication real locks order one rename owner-only and byte-unchanged pool files', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  const before = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  await runtime.publishNativeLocalCredentialValidation(f.paths, f.event)
  expect(controls.events).toEqual([
    'acquire:pool-config',
    'acquire:pool-state',
    'read',
    'acquire:native-runtime',
    'read',
    'assert:pool-config',
    'assert:pool-state',
    'assert:native-runtime',
    'rename',
    'release:native-runtime',
    'release:pool-state',
    'release:pool-config',
  ])
  expect(controls.heldAtRenames).toEqual([
    ['pool-config', 'pool-state', 'native-runtime'],
  ])
  expect(controls.reads).toBe(2)
  expect(controls.renames).toBe(1)
  expect(controls.forbidden).toBe(0)
  expect(controls.held.size).toBe(0)
  for (const path of [f.paths.config, f.paths.state, f.paths.runtime])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(before)
  const bytes = await readFile(f.paths.runtime, 'utf8')
  expect(bytes).not.toContain(credential.access)
  expect(bytes).not.toContain(credential.refresh)
})

for (const name of ['pool-config', 'pool-state', 'native-runtime']) {
  test(`known publication refuses actual ${name} lease loss with no rename`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    controls.control.afterSync = async () => {
      const path =
        name === 'pool-config'
          ? f.paths.config
          : name === 'pool-state'
            ? f.paths.state
            : f.paths.runtime
      await rm(lockPathFor(path, name))
    }
    await refused(
      f,
      f.event,
      'publication-refused',
      runtime.publishNativeLocalCredentialValidation,
    )
    expect(controls.renames).toBe(0)
    expect(controls.held.size).toBe(0)
  })
}

test('known publication final version recheck rejects same-epoch access-only change', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  const oldState = await readFile(f.paths.state, 'utf8')
  const oldConfig = await readFile(f.paths.config, 'utf8')
  await f.store.rotate('row', { ...credential, access: 'intervening-access' })
  const replacement = JSON.parse(await readFile(f.paths.state, 'utf8'))
  delete replacement.accounts.row.lastRefreshedAt
  await writeFile(f.paths.state, oldState, { mode: 0o600 })
  await writeFile(f.paths.config, oldConfig, { mode: 0o600 })
  controls.control.afterSync = async () => {
    // Replace the credentials with correctly stamped material before the rename.
    // The production final read, not an extra test check, must reject the changed
    // token even though its account UUID and epoch are unchanged.
    await writeFile(f.paths.state, JSON.stringify(replacement), { mode: 0o600 })
  }
  await refused(
    f,
    f.event,
    'publication-refused',
    runtime.publishNativeLocalCredentialValidation,
  )
  expect(controls.reads).toBe(2)
  expect(controls.renames).toBe(0)
  const read = await f.store.read()
  expect(read.status === 'ready' && read.rows[0]?.stamp).toBe('bound')
  expect(read.status === 'ready' && read.rows[0]?.credentialEpoch).toBe(
    f.subject.binding.credentialEpoch,
  )
})

test('known publication captures proof paths and reset context before lock waits', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  const event = structuredClone(f.event)
  const paths = { ...f.paths }
  controls.control.afterAcquire = async (name) => {
    if (name !== 'pool-config') return
    event.credentialVersion = {}
    if (!event.context) throw new Error('Missing fixture context')
    event.context = { ...event.context, quotaErrorGeneration: 100 }
    paths.runtime = join(f.root, 'wrong-runtime')
  }
  expect(
    (await runtime.publishNativeLocalCredentialValidation(paths, event))
      .accounts.row?.credentialValidation,
  ).toEqual(f.subject)
  expect((await readdir(f.root)).includes('wrong-runtime')).toBe(false)
})

function coordinator(f: Fixture, publish: boolean, refresh = false) {
  let exchanges = 0
  let lookups = 0
  const observations: NativeRefreshObservation[] = []
  const instance = createNativeRefreshCoordinator({
    paths: f.paths,
    quota: nativeQuotaCodec,
    refreshToken: async () => {
      exchanges++
      if (!refresh) throw new Error('Unnecessary exchange forbidden')
      return {
        ...credential,
        access: 'coordinator-successor-access',
        refresh: 'coordinator-successor-refresh',
        expiresIn: 3600,
      }
    },
    resolveIdentity: async () => {
      lookups++
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid as ProviderAccountUuid,
      }
    },
    readRestrictions: async (subject: NativeRefreshSubject) => ({
      restriction: { status: 'allowed' },
      context: { ...f.event.context, subject },
    }),
    readAdmission: async (subject) => {
      const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
      const validation =
        saved.status === 'ready'
          ? saved.state.accounts.row?.credentialValidation
          : undefined
      const read = await f.store.read()
      const row =
        read.status === 'ready'
          ? read.rows.find((row) => row.id === subject.binding.rowId)
          : undefined
      return validation &&
        nativeLocalCredentialValidationMatches(
          validation,
          subject.binding,
          row?.credential,
        ) &&
        nativeLocalCredentialValidationMatches(
          subject,
          subject.binding,
          row?.credential,
        )
        ? { status: 'proven', validation }
        : { status: 'unproven' }
    },
    reconcile: async (event) => {
      observations.push(event)
      if (publish) await publishNativeLocalCredentialValidation(f.paths, event)
    },
  })
  return { instance, observations, counts: () => ({ exchanges, lookups }) }
}

test('known coordinator validation reconcile and exact read admission serve without token exchange', async () => {
  const f = await fixture()
  const before = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  const c = coordinator(f, true)
  expect(
    await c.instance.authorize({
      binding: f.subject.binding,
      intent: 'serve',
      mode: 'local',
    }),
  ).toMatchObject({
    status: 'usable',
    source: 'validated',
    binding: f.subject.binding,
  })
  expect(c.observations.map((e) => e.status)).toEqual(['validation-observed'])
  expect(c.counts()).toEqual({ exchanges: 0, lookups: 1 })
  expect(
    await c.instance.authorize({
      binding: f.subject.binding,
      intent: 'serve',
      mode: 'local',
    }),
  ).toMatchObject({ status: 'usable', source: 'current' })
  expect(c.counts()).toEqual({ exchanges: 0, lookups: 1 })
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(before)
})

test('known coordinator bootstrap alone without matching publication never serves', async () => {
  const f = await fixture()
  const c = coordinator(f, false)
  const before = await readFile(f.paths.runtime, 'utf8')
  expect(
    await c.instance.authorize({
      binding: f.subject.binding,
      intent: 'serve',
      mode: 'local',
    }),
  ).toMatchObject({ status: 'refused' })
  expect(c.observations.map((e) => [e.status, e.bootstrap])).toEqual([
    ['validation-observed', 'resolved'],
  ])
  expect(c.counts()).toEqual({ exchanges: 0, lookups: 1 })
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
})

test('known coordinator refresh publishes actual saved successor while preserving captured context', async () => {
  const f = await fixture({
    refreshErrorClearedAt: 0,
    quotaErrorGeneration: 2,
    lastUsed: 5,
  })
  const c = coordinator(f, true, true)
  expect(
    await c.instance.authorize({
      binding: f.subject.binding,
      intent: 'serve',
      mode: 'local',
      rejectedAccessToken: credential.access,
    }),
  ).toMatchObject({ status: 'usable', source: 'rotated' })
  expect(c.counts()).toEqual({ exchanges: 1, lookups: 1 })
  expect(c.observations.map((e) => e.status)).toEqual(['persisted'])
  const read = await f.store.read()
  const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    read.status === 'ready' &&
      saved.status === 'ready' &&
      nativeLocalCredentialValidationMatches(
        saved.state.accounts.row?.credentialValidation,
        f.subject.binding,
        read.rows[0]?.credential,
      ),
  ).toBe(true)
  expect(
    saved.status === 'ready' && saved.state.accounts.row?.refreshErrorClearedAt,
  ).toBe(0)
  expect(
    saved.status === 'ready' && saved.state.accounts.row?.quotaErrorGeneration,
  ).toBe(2)
  expect(saved.status === 'ready' && saved.state.accounts.row?.lastUsed).toBe(5)
})

// TestLifetime signals cancellation before waiting for the test body to finish.
// Stop the child on that signal; deferred cleanup runs too late if the body waits
// for the child. Join the process and both pipe reads, even when one read fails,
// before releasing the cancellation handler or deleting the fixture.
function joinOwnedChild(
  child: Pick<Bun.Subprocess, 'exitCode' | 'kill'>,
  lifetime: Pick<TestLifetime, 'gate' | 'trackDetached'>,
  exited: Promise<number>,
  stdout: Promise<string>,
  stderr: Promise<string>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const cancel = lifetime.gate()
  const cancellation = cancel.wait.then(() => {
    if (child.exitCode === null) child.kill()
  })
  lifetime.trackDetached(cancellation)
  const work = [exited, stdout, stderr]
  const output = (async () => {
    try {
      const [exit, out, err] = await Promise.all([exited, stdout, stderr])
      return { exit, stdout: out, stderr: err }
    } catch (error) {
      cancel.open()
      // Propagate the first pipe error instead of replacing it with another
      // error from the process or its other pipe.
      throw error
    } finally {
      await Promise.allSettled(work)
      cancel.open()
      await cancellation
    }
  })()
  // The caller receives the original error. The lifetime tracker waits for the
  // complete child operation but does not report that error again in teardown.
  lifetime.trackDetached(
    output.then(
      () => {},
      () => {},
    ),
  )
  return output
}

test('known child lifetime gate cancels under real leases before joining body and pipes', async () => {
  const f = await fixture()
  const lifetime = new TestLifetime()
  const entered = Promise.withResolvers<void>()
  const closing = gate()
  trackDetached(closing.wait.then(() => lifetime.finish()))
  let exitSettled = false
  let stdoutSettled = false
  let stderrSettled = false
  let cleanupAfterAll = false
  lifetime.deferCleanup(async () => {
    cleanupAfterAll = exitSettled && stdoutSettled && stderrSettled
    await rm(f.root, { recursive: true, force: true })
  })
  const script = `
    import { withLock } from ${JSON.stringify(import.meta.resolve('@cortexkit/common-auth/fs'))};
    const paths = ${JSON.stringify(f.paths)};
    await withLock(paths.config, { name: 'pool-config', ttlMs: 10000, timeoutMs: 15000, renew: true }, async () =>
      withLock(paths.state, { name: 'pool-state', ttlMs: 10000, timeoutMs: 15000, renew: true }, async () =>
        withLock(paths.runtime, { name: 'native-runtime', ttlMs: 10000, timeoutMs: 15000, renew: true }, async () => {
          console.log('owned-leases-entered'); setInterval(() => {}, 1000); await new Promise(() => {});
        })));
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exited = child.exited.finally(() => {
    exitSettled = true
  })
  const stdoutPipe = child.stdout.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        entered.resolve()
      },
    }),
  )
  const stdout = new Response(stdoutPipe).text().finally(() => {
    stdoutSettled = true
    entered.resolve()
  })
  const stderr = new Response(child.stderr).text().finally(() => {
    stderrSettled = true
  })
  const body = lifetime.runBody(() =>
    joinOwnedChild(child, lifetime, exited, stdout, stderr),
  )
  const observedBody = body.then(
    (result) => ({ result }),
    (error) => ({ error }),
  )
  await entered.promise
  // Call lifetime.finish() while the child holds its file locks. This must stop
  // the child without relying on Bun's process cleanup after a test timeout.
  await lifetime.finish()
  const output = await observedBody
  if (!('result' in output)) throw output.error
  expect(output.result.stdout).toContain('owned-leases-entered')
  expect(output.result.stderr).toBe('')
  // Bun leaves exitCode null for signal termination; the joined exited promise
  // and recorded signal, not that nullable property, establish child settlement.
  expect(output.result.exit).not.toBe(0)
  expect(child.signalCode).toBe('SIGTERM')
  expect(cleanupAfterAll).toBe(true)
  closing.open()
})

test('known child pipe rejection joins exited and sibling read before cleanup preserving original failure', async () => {
  const f = await fixture()
  const lifetime = new TestLifetime()
  const resumeSibling = lifetime.gate()
  const entered = Promise.withResolvers<void>()
  const firstFailure = Promise.withResolvers<unknown>()
  const removed = Promise.withResolvers<void>()
  let exitSettled = false
  let siblingSettled = false
  let cleanupStarted = false
  let cleanupAfterExit = false
  let cleanupAfterSibling = false
  let siblingRead = 'pending'
  lifetime.deferCleanup(async () => {
    cleanupStarted = true
    cleanupAfterExit = exitSettled
    cleanupAfterSibling = siblingSettled
    try {
      await rm(f.root, { recursive: true, force: true })
    } finally {
      removed.resolve()
    }
  })
  const child = Bun.spawn(
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const exited = child.exited.finally(() => {
    exitSettled = true
  })
  // Acquire a stdout reader before constructing the Response. Its read must
  // reject because the real child stream is locked, not because of a mock error.
  const reader = child.stdout.getReader()
  const stdout = Promise.resolve()
    .then(() => new Response(child.stdout).text())
    .catch((error: unknown) => {
      firstFailure.resolve(error)
      throw error
    })
  const stderrPipe = child.stderr.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush() {
        entered.resolve()
        await resumeSibling.wait
        if (cleanupStarted) await removed.promise
        try {
          await readFile(f.paths.runtime)
          siblingRead = 'present'
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ENOENT'
          )
            throw error
          siblingRead = 'ENOENT'
        }
      },
    }),
  )
  const stderr = new Response(stderrPipe).text().finally(() => {
    siblingSettled = true
  })
  const body = lifetime.runBody(() =>
    joinOwnedChild(child, lifetime, exited, stdout, stderr),
  )
  const observedBody = body.catch((error: unknown) => error)
  const originalError = await firstFailure.promise
  await entered.promise
  await lifetime.finish()
  const bodyError = await observedBody
  // The fixture waits for the child and both reads even if joinOwnedChild is
  // broken, so a failing assertion cannot leave those operations running.
  await Promise.allSettled([exited, stdout, stderr])
  reader.releaseLock()
  expect(originalError).toBeInstanceOf(Error)
  expect(originalError).toMatchObject({
    message: 'ReadableStream has already been used',
  })
  expect(bodyError).toBe(originalError)
  expect(cleanupAfterExit).toBe(true)
  expect(cleanupAfterSibling).toBe(true)
  expect(siblingRead).toBe('present')
  expect(siblingSettled).toBe(true)
})

test('known publication child strict pool reads and publication perform no provider HTTP', async () => {
  const f = await fixture()
  const script = `
    import { publishNativeLocalCredentialValidation } from ${JSON.stringify(new URL('../native-runtime.ts', import.meta.url).href)};
    let http = 0; globalThis.fetch = async () => { http++; throw new Error('HTTP forbidden'); };
    const next = await publishNativeLocalCredentialValidation(${JSON.stringify(f.paths)}, ${JSON.stringify(f.event)});
    console.log(JSON.stringify({ proof: !!next.accounts.row?.credentialValidation, http }));
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exited = child.exited
  const out = new Response(child.stdout).text()
  const err = new Response(child.stderr).text()
  const { exit, stdout, stderr } = await joinOwnedChild(
    child,
    { gate, trackDetached },
    exited,
    out,
    err,
  )
  expect(exit).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ proof: true, http: 0 })
  expect(stderr).toBe('')
})
