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

import { ClaudeOAuthRefreshError } from '../auth.ts'
import { createNativeLocalRuntimeReaders } from '../native-local-runtime-readers.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshObservation,
  type NativeRefreshSubject,
} from '../native-refresh-coordinator.ts'
import {
  classifyNativeLocalFailure,
  isNativeRuntimeStagingName,
  type NativeLocalFailurePolicy,
  type NativeRuntimeEntry,
  publishNativeLocalRefreshFailure,
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
const credential = {
  type: 'oauth' as const,
  access: 'synthetic-failure-access',
  refresh: 'synthetic-failure-refresh',
  expires: 4_000_000_000_000,
}

function subjectOf(
  paths: Awaited<ReturnType<typeof resolveNativePoolPaths>>,
  row: PoolRow,
): NativeRefreshSubject {
  const c = row.credential
  if (c?.type !== 'oauth') throw new Error('Missing fixture credential')
  return {
    binding: captureNativeLocalPoolBinding(paths, row),
    credentialFingerprint: fingerprintOf(c),
    version: {
      accessFingerprint: c.access ? tokenFingerprint(c.access) : undefined,
      expires: c.expires,
      ...(Object.hasOwn(c, 'lastRefreshedAt')
        ? { lastRefreshedAt: c.lastRefreshedAt }
        : {}),
    },
  }
}

async function fixture(
  metadata: Partial<NativeRuntimeEntry> = {},
  unknown = false,
  sparse = false,
  missing = false,
) {
  const parent = new URL(
    '../../../../node_modules/.cache/native-refresh-failure-evidence/',
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
  await store.add({
    id: 'row',
    ...(!unknown ? { identity: uuid } : {}),
    credential: sparse
      ? { type: 'oauth', refresh: credential.refresh }
      : credential,
  })
  const state = JSON.parse(await readFile(paths.state, 'utf8'))
  delete state.accounts.row.lastRefreshedAt
  await writeFile(paths.state, JSON.stringify(state), { mode: 0o600 })
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
          binding: { ...subject.binding, rowId: 'unrelated' },
          lastUsed: 5,
        },
      },
      relay: { token: 'synthetic-relay-metadata' },
    }),
  )
  const event: NativeRefreshObservation = {
    status: 'failed',
    failure: { kind: 'provider', classification: 'transient', status: 429 },
    persisted: false,
    binding: subject.binding,
    credentialFingerprint: subject.credentialFingerprint,
    credentialVersion: subject.version,
    attempt: 1,
    bootstrap: 'unavailable',
    handoff: 'not-needed',
    context: {
      subject,
      runtimeBinding: missing ? null : subject.binding,
      refreshErrorClearedAt: metadata.refreshErrorClearedAt ?? null,
      quotaErrorClearedAt: metadata.quotaErrorClearedAt ?? null,
      quotaErrorGeneration: metadata.quotaErrorGeneration ?? null,
    },
  }
  return { root, paths, store, subject, runtime, event }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const policy = { checkedAt: 100, nextRetryAt: 200, retryCount: 1 }

async function unchanged(
  f: Fixture,
  run: () => Promise<unknown>,
  expected: unknown,
) {
  const before = await readFile(f.paths.runtime, 'utf8')
  expect(await run()).toEqual(expected)
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
  expect(
    (await readdir(f.root)).filter((name) =>
      isNativeRuntimeStagingName(f.paths.runtime, name),
    ),
  ).toEqual([])
}

async function refused(
  f: Fixture,
  run: () => Promise<unknown>,
  code = 'publication-refused',
) {
  const before = await readFile(f.paths.runtime, 'utf8')
  let error: unknown
  try {
    await run()
  } catch (caught) {
    error = caught
  }
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
  expect(
    (await readdir(f.root)).filter((name) =>
      isNativeRuntimeStagingName(f.paths.runtime, name),
    ),
  ).toEqual([])
  expect(error).toMatchObject({ name: 'NativeRuntimeError', code })
  for (const secret of [
    credential.access,
    credential.refresh,
    'synthetic-provider-body',
  ])
    expect(String(error)).not.toContain(secret)
}

async function savedSuccessor(f: Fixture): Promise<NativeRefreshObservation> {
  await f.store.rotate('row', {
    ...credential,
    access: 'synthetic-successor-access',
    refresh: 'synthetic-successor-refresh',
  })
  const read = await f.store.read()
  if (read.status !== 'ready' || !read.rows[0])
    throw new Error('Missing saved successor')
  const successor = subjectOf(f.paths, read.rows[0])
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

// Instrument runtime locks and file operations without adding lease checks to
// the test's rename helper. Only production checks can prevent an unsafe write,
// so removing one must let the assertions detect changed runtime bytes.
async function instrumented(f: Fixture) {
  const directory = join(f.root, 'instrumentation')
  await mkdir(directory)
  const sourcePath = new URL('../native-runtime.ts', import.meta.url)
  let source = await readFile(sourcePath, 'utf8')
  source = source
    .replace(
      /from '(\.\/[^']+)'/g,
      (_match, relative: string) =>
        `from '${new URL(relative, sourcePath).href}'`,
    )
    .replace("from 'node:fs/promises'", "from './controls.ts'")
    .replace("from '@cortexkit/common-auth/fs'", "from './controls.ts'")
    .replace(
      "from '@cortexkit/common-auth/store'",
      `from '${import.meta.resolve('@cortexkit/common-auth/store')}'`,
    )
    .replace(
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
export let reads = 0; export let renames = 0; export let forbidden = 0; export let fileIO = 0;
export const control = { afterSync: async () => {}, afterAcquire: async () => {}, failStageCleanup: false };
export async function rm(...args) {
  if (control.failStageCleanup && String(args[0]).endsWith('.partial')) throw new Error('synthetic-provider-body cleanup fault');
  return fs.rm(...args);
}
export async function lstat(...args) { fileIO++; return fs.lstat(...args); }
export async function mkdir(...args) { fileIO++; return fs.mkdir(...args); }
export async function open(...args) {
  fileIO++; const file = await fs.open(...args);
  if (args[1] !== 'wx') return file;
  return new Proxy(file, { get(target, key) {
    if (key === 'sync') return async () => { await target.sync(); await control.afterSync(); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  }});
}
export async function rename(...args) { events.push('rename'); renames++; heldAtRenames.push([...held]); await fs.rename(...args); }
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
    fileIO: number
    control: {
      afterSync: () => Promise<void>
      afterAcquire: (name: string) => Promise<void>
      failStageCleanup: boolean
    }
  } = await import(pathToFileURL(join(directory, 'controls.ts')).href)
  return { runtime, controls }
}

for (const [status, classification, calls] of [
  [400, 'invalid-grant', 1],
  [403, 'permanent', 1],
  [429, 'transient', 1],
  [500, 'transient', 3],
] as const) {
  test(`public refresh status${status} invalid_grant classification and bounded retries`, async () => {
    const f = await fixture()
    let exchanges = 0
    const observations: NativeRefreshObservation[] = []
    const c = createNativeRefreshCoordinator({
      paths: f.paths,
      quota: nativeQuotaCodec,
      refreshToken: async (input) => {
        expect(input.maxRetries).toBe(0)
        exchanges++
        throw new ClaudeOAuthRefreshError(
          status,
          'invalid_grant synthetic-provider-body',
          '7',
        )
      },
      resolveIdentity: async () => {
        throw new Error('Lookup forbidden')
      },
      readRestrictions: async (subject) => ({
        restriction: { status: 'allowed' },
        context: { ...f.event.context!, subject },
      }),
      readAdmission: async () => ({ status: 'unproven' }),
      reconcile: async (event) => {
        observations.push(event)
      },
    })
    expect(
      await c.authorize({
        binding: f.subject.binding,
        intent: 'serve',
        mode: 'local',
        rejectedAccessToken: credential.access,
      }),
    ).toMatchObject({
      status: 'failed',
      persisted: false,
      failure: { kind: 'provider', classification, status, retryAfter: 7 },
    })
    expect(exchanges).toBe(calls)
    expect(observations).toHaveLength(calls)
  })
}

test('failure real locks strict rereads metadata pool bytes and owner-only mode', async () => {
  const metadata: Partial<NativeRuntimeEntry> = {
    lastUsed: 7,
    lastRefreshedAt: 8,
    refreshErrorClearedAt: 0,
    quotaErrorClearedAt: 0,
    quotaErrorGeneration: 0,
    refreshLeaseId: 'synthetic-lease',
    refreshLeaseUntil: 500,
    refreshLeaseTokenHash: 'a'.repeat(64),
    lastQuotaRefreshError: {
      message: 'synthetic-quota',
      checkedAt: 3,
      permanent: false,
    },
    quotaCheckedAt: 4,
    quotaToken: 'b'.repeat(16),
    profile: { tier: 'synthetic-tier', orgType: 'synthetic-org', checkedAt: 6 },
    prime: { count: 1, inputTokens: 2, outputTokens: 3, since: 4 },
    authLineageId: 'synthetic-lineage',
    primeAuthLineageRefreshTokenFingerprint: 'c'.repeat(16),
  }
  const f = await fixture(metadata)
  const { runtime, controls } = await instrumented(f)
  const pool = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  const result = await runtime.publishNativeLocalRefreshFailure(
    f.paths,
    f.event,
    policy,
  )
  expect(result.status).toBe('published')
  if (result.status !== 'published') throw new Error('Not published')
  const entry = { ...result.state.accounts.row }
  delete entry.lastRefreshError
  expect(entry).toEqual(f.runtime.accounts.row!)
  expect(result.state.accounts.unrelated).toEqual(f.runtime.accounts.unrelated)
  expect(result.state.relay).toEqual(f.runtime.relay)
  expect(result.state.accounts.row?.lastRefreshError).toEqual({
    message: 'Local refresh failed',
    credentialFingerprint: f.subject.credentialFingerprint,
    accountIdentity: uuid,
    permanent: false,
    status: 429,
    ...policy,
  })
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
  expect(controls.forbidden).toBe(0)
  expect(controls.renames).toBe(1)
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(pool)
  for (const path of [f.paths.config, f.paths.state, f.paths.runtime])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  const bytes = await readFile(f.paths.runtime, 'utf8')
  expect(bytes).not.toContain(credential.access)
  expect(bytes).not.toContain(credential.refresh)
})

for (const name of ['pool-config', 'pool-state', 'native-runtime']) {
  test(`failure refuses actual ${name} ownership loss without test masks`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    controls.control.afterSync = async () => {
      await rm(
        lockPathFor(
          name === 'pool-config'
            ? f.paths.config
            : name === 'pool-state'
              ? f.paths.state
              : f.paths.runtime,
          name,
        ),
      )
    }
    await refused(
      f,
      () => runtime.publishNativeLocalRefreshFailure(f.paths, f.event, policy),
      'publication-refused',
    )
    expect(controls.renames).toBe(0)
    expect(controls.held.size).toBe(0)
  })
}

test('failure captures event policy paths and original reset values before waits', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  const event = structuredClone(f.event)
  const paths = { ...f.paths }
  const options = { ...policy }
  controls.control.afterAcquire = async (name) => {
    if (name !== 'pool-config') return
    event.credentialVersion = {}
    event.context = { ...event.context!, quotaErrorGeneration: 77 }
    paths.runtime = join(f.root, 'wrong-runtime')
    options.checkedAt = 2.5
  }
  expect(
    await runtime.publishNativeLocalRefreshFailure(paths, event, options),
  ).toMatchObject({
    status: 'published',
    state: { accounts: { row: { lastRefreshError: { checkedAt: 100 } } } },
  })
  expect((await readdir(f.root)).includes('wrong-runtime')).toBe(false)
})

test('failure sparse predecessor records exact absence without proof', async () => {
  const f = await fixture({}, true, true)
  const result = await publishNativeLocalRefreshFailure(
    f.paths,
    f.event,
    policy,
  )
  expect(result).toMatchObject({
    status: 'published',
    state: {
      accounts: {
        row: {
          binding: f.subject.binding,
          lastRefreshError: {
            permanent: false,
            credentialFingerprint: f.subject.credentialFingerprint,
          },
        },
      },
    },
  })
  const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  if (saved.status !== 'ready') throw new Error('Missing runtime')
  expect(saved.state.accounts.row?.credentialValidation).toBeUndefined()
  expect(saved.state.accounts.row?.validationRetry).toBeUndefined()
})

for (const field of ['access', 'expires', 'lastRefreshedAt'] as const) {
  test(`failure sparse exact presence rejects appearing ${field}`, async () => {
    const f = await fixture({}, true, true)
    const { runtime, controls } = await instrumented(f)
    // Store rotation updates the credential/config digests. The test must
    // reject the changed credential version, not damaged storage.
    await f.store.rotate('row', {
      type: 'oauth',
      refresh: credential.refresh,
      ...(field === 'access'
        ? { access: credential.access }
        : field === 'expires'
          ? { expires: 0 }
          : {}),
    })
    const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
    if (field === 'lastRefreshedAt') state.accounts.row.lastRefreshedAt = 0
    else delete state.accounts.row.lastRefreshedAt
    await writeFile(f.paths.state, JSON.stringify(state), { mode: 0o600 })
    await unchanged(
      f,
      () => runtime.publishNativeLocalRefreshFailure(f.paths, f.event, policy),
      { status: 'superseded', reason: 'row-credential' },
    )
    expect(controls.renames).toBe(0)
  })
}

for (const timing of ['first', 'final'] as const) {
  test(`failure ${timing} guarded pool read rejects access-only rotation`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    const originalConfig = await readFile(f.paths.config, 'utf8')
    const originalState = await readFile(f.paths.state, 'utf8')
    await f.store.rotate('row', { ...credential, access: 'independent-access' })
    const rotated = JSON.parse(await readFile(f.paths.state, 'utf8'))
    delete rotated.accounts.row.lastRefreshedAt
    if (timing === 'first')
      await writeFile(f.paths.state, JSON.stringify(rotated), { mode: 0o600 })
    else {
      await writeFile(f.paths.config, originalConfig, { mode: 0o600 })
      await writeFile(f.paths.state, originalState, { mode: 0o600 })
      controls.control.afterSync = async () => {
        await writeFile(f.paths.state, JSON.stringify(rotated), { mode: 0o600 })
      }
    }
    await unchanged(
      f,
      () => runtime.publishNativeLocalRefreshFailure(f.paths, f.event, policy),
      { status: 'superseded', reason: 'row-credential' },
    )
    expect(controls.renames).toBe(0)
    expect(controls.reads).toBe(timing === 'first' ? 1 : 2)
    if (timing === 'first')
      expect(controls.events).not.toContain('acquire:native-runtime')
  })
}

test('failure committed unknown bootstrap is non-dead recovery not identity proof', async () => {
  const f = await fixture({}, true)
  const event = await savedSuccessor(f)
  const result = await publishNativeLocalRefreshFailure(f.paths, event, policy)
  expect(result.status).toBe('published')
  if (result.status !== 'published') throw new Error('Not published')
  expect(result.attribution.target).toBe('committed')
  expect(result.state.accounts.row).toEqual({
    binding: f.subject.binding,
    lastRefreshError: {
      message: 'Local account-check recovery required',
      permanent: false,
      credentialFingerprint:
        event.status === 'persisted'
          ? event.committed.credentialFingerprint
          : '',
      ...policy,
    },
  })
  expect(
    result.state.accounts.row?.lastRefreshError?.credentialFingerprint,
  ).not.toBe(f.subject.credentialFingerprint)
  expect(
    result.state.accounts.row?.lastRefreshError?.accountIdentity,
  ).toBeUndefined()
})

test('failure committed known validation retry retains predecessor errors and metadata', async () => {
  const previous = {
    message: 'synthetic-predecessor',
    checkedAt: 5,
    credentialFingerprint: 'a'.repeat(64),
    permanent: false,
  }
  const f = await fixture({
    lastRefreshError: previous,
    lastUsed: 9,
    refreshErrorClearedAt: 0,
  })
  const event = await savedSuccessor(f)
  const result = await publishNativeLocalRefreshFailure(f.paths, event, policy)
  expect(result.status).toBe('published')
  if (result.status !== 'published' || event.status !== 'persisted')
    throw new Error('Not published')
  expect(result.state.accounts.row as unknown).toEqual({
    ...f.runtime.accounts.row!,
    validationRetry: {
      subject: {
        binding: { ...f.subject.binding, identity: uuid },
        ...event.committed,
      },
      checkedAt: 100,
      nextRetryAt: 200,
    },
  })
  expect(result.state.accounts.row?.credentialValidation).toBeUndefined()
  const failed: NativeRefreshObservation = {
    ...f.event,
    status: 'failed',
    persisted: true,
    committed: event.committed,
    failure: { kind: 'after-persist-hook', classification: 'permanent' },
  }
  expect(classifyNativeLocalFailure(failed)).toMatchObject({
    kind: 'validation-retry',
    target: 'committed',
    subject: event.committed,
  })
})

test('failure known pre-network validation retry leaves lastRefreshError untouched', async () => {
  const f = await fixture({
    lastRefreshError: {
      message: 'synthetic-existing',
      checkedAt: 5,
      permanent: false,
    },
  })
  const event: NativeRefreshObservation = {
    ...f.event,
    status: 'failed',
    persisted: false,
    failure: { kind: 'validation', classification: 'permanent' },
  }
  expect(
    await publishNativeLocalRefreshFailure(f.paths, event, policy),
  ).toMatchObject({
    status: 'published',
    state: {
      accounts: {
        row: {
          lastRefreshError: f.runtime.accounts.row?.lastRefreshError,
          validationRetry: {
            subject: f.subject,
            checkedAt: 100,
            nextRetryAt: 200,
          },
        },
      },
    },
  })
})

test('failure non-attributable events skip zero file lock and staging I/O preserving backoff', async () => {
  const f = await fixture({
    lastRefreshError: {
      message: 'synthetic-bound-backoff',
      checkedAt: 5,
      nextRetryAt: 500,
      permanent: false,
      credentialFingerprint: fingerprintOf(credential),
    },
  })
  const { runtime, controls } = await instrumented(f)
  const variants: [NativeRefreshObservation, string][] = [
    [{ ...f.event, context: undefined }, 'no-context'],
    [
      {
        ...f.event,
        status: 'failed',
        persisted: true,
        failure: { kind: 'unexpected', classification: 'permanent' },
      },
      'missing-committed',
    ],
    [
      {
        ...f.event,
        status: 'failed',
        persisted: false,
        failure: { kind: 'caller-hook', classification: 'permanent' },
      },
      'not-attributable',
    ],
    [
      {
        ...f.event,
        status: 'failed',
        persisted: false,
        failure: { kind: 'load-error', classification: 'permanent' },
      },
      'not-attributable',
    ],
    [{ ...f.event, bootstrap: 'resolved' }, 'not-attributable'],
    [
      { ...f.event, status: 'refused', reason: 'synthetic', consumed: true },
      'not-a-failure',
    ],
    [
      {
        ...f.event,
        status: 'adopted',
        successorFingerprint: f.subject.credentialFingerprint,
        successorVersion: f.subject.version,
      },
      'not-a-failure',
    ],
    [
      {
        ...f.event,
        status: 'identity-contradicted',
        expectedIdentity: uuid,
        returnedIdentity: 'other',
        successorFingerprint: f.subject.credentialFingerprint,
        successorVersion: f.subject.version,
        committed: {
          credentialFingerprint: f.subject.credentialFingerprint,
          version: f.subject.version,
        },
      },
      'not-a-failure',
    ],
  ]
  for (const [event, reason] of variants)
    await unchanged(
      f,
      () => runtime.publishNativeLocalRefreshFailure(f.paths, event, policy),
      { status: 'skipped', reason },
    )
  expect(controls.fileIO).toBe(0)
  expect(controls.events).toEqual([])
  expect(controls.reads).toBe(0)
})

for (const key of [
  'refreshErrorClearedAt',
  'quotaErrorClearedAt',
  'quotaErrorGeneration',
] as const) {
  test(`failure captured ${key} null is not a concurrent zero reset`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    controls.control.afterAcquire = async (name) => {
      if (name !== 'native-runtime') return
      await writeFile(
        f.paths.runtime,
        JSON.stringify({
          ...f.runtime,
          accounts: {
            ...f.runtime.accounts,
            row: { ...f.runtime.accounts.row, [key]: 0 },
          },
        }),
        { mode: 0o600 },
      )
    }
    // The runtime file now contains a concurrent reset to zero. Publication
    // must retain that reset instead of restoring the original null context.
    const result = await runtime.publishNativeLocalRefreshFailure(
      f.paths,
      f.event,
      policy,
    )
    expect(result).toEqual({ status: 'superseded', reason: 'reset-context' })
    const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
    expect(saved.status === 'ready' && saved.state.accounts.row?.[key]).toBe(0)
    expect(controls.renames).toBe(0)
  })
}

test('failure runtime entry epoch retargeting supersedes without repair', async () => {
  const f = await fixture()
  const entry = f.runtime.accounts.row!
  await writeFile(
    f.paths.runtime,
    JSON.stringify({
      ...f.runtime,
      accounts: {
        ...f.runtime.accounts,
        row: { ...entry, binding: { ...entry.binding, credentialEpoch: 2 } },
      },
    }),
    { mode: 0o600 },
  )
  await unchanged(
    f,
    () => publishNativeLocalRefreshFailure(f.paths, f.event, policy),
    { status: 'superseded', reason: 'entry-binding' },
  )
})

test('failure missing entry allowed only for genuinely null captured binding', async () => {
  const f = await fixture({}, false, false, true)
  expect(
    await publishNativeLocalRefreshFailure(f.paths, f.event, policy),
  ).toMatchObject({ status: 'published' })
  await unchanged(
    f,
    () => publishNativeLocalRefreshFailure(f.paths, f.event, policy),
    { status: 'superseded', reason: 'entry-binding' },
  )
})

test('failure older refresh error ordering supersedes without clearing', async () => {
  const f = await fixture({
    lastRefreshError: {
      message: 'synthetic-newer',
      checkedAt: 101,
      permanent: false,
    },
  })
  await unchanged(
    f,
    () => publishNativeLocalRefreshFailure(f.paths, f.event, policy),
    { status: 'superseded', reason: 'older-than-stored' },
  )
})

for (const field of ['credentialValidation', 'validationRetry'] as const) {
  test(`failure ${field} exact subject ordering supersedes validation retry`, async () => {
    const f = await fixture()
    const stored =
      field === 'credentialValidation'
        ? f.subject
        : { subject: f.subject, checkedAt: 101, nextRetryAt: 300 }
    await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
      current.accounts.row = { ...current.accounts.row!, [field]: stored }
      return current
    })
    const event: NativeRefreshObservation = {
      ...f.event,
      status: 'failed',
      persisted: false,
      failure: { kind: 'validation', classification: 'transient' },
    }
    await unchanged(
      f,
      () => publishNativeLocalRefreshFailure(f.paths, event, policy),
      {
        status: 'superseded',
        reason:
          field === 'credentialValidation'
            ? 'already-proven'
            : 'older-than-stored',
      },
    )
  })
}

test('failure policy refuses unsafe fractional missing deadlines and clear floor equality', async () => {
  const f = await fixture({ refreshErrorClearedAt: 100 })
  const variants: NativeLocalFailurePolicy[] = [
    policy,
    { checkedAt: 2.5, nextRetryAt: 200 },
    { checkedAt: -1 },
    { checkedAt: Number.MAX_SAFE_INTEGER + 1 },
    { checkedAt: 101 },
    { checkedAt: 101, nextRetryAt: 100 },
    { checkedAt: 101, nextRetryAt: 102.5 },
    { checkedAt: 101, nextRetryAt: 200, retryCount: 0.5 },
  ]
  for (const options of variants)
    await refused(f, () =>
      publishNativeLocalRefreshFailure(f.paths, f.event, options),
    )
  expect(
    await publishNativeLocalRefreshFailure(f.paths, f.event, {
      checkedAt: 101,
      nextRetryAt: 101,
      retryCount: 0,
    }),
  ).toMatchObject({ status: 'published' })
})

test('failure invalid context sparse validation and committed contradictions are refused', async () => {
  const f = await fixture()
  for (const event of [
    { ...f.event, context: { ...f.event.context!, quotaErrorGeneration: 0.5 } },
    {
      ...f.event,
      context: { ...f.event.context!, refreshErrorClearedAt: undefined },
    },
    { ...f.event, credentialFingerprint: 'legacy-short-hash' },
    {
      ...f.event,
      credentialVersion: { ...f.subject.version, lastRefreshedAt: 0 },
    },
  ])
    await refused(f, () =>
      publishNativeLocalRefreshFailure(
        f.paths,
        event as NativeRefreshObservation,
        policy,
      ),
    )
  const sparse = await fixture({}, true, true)
  await refused(sparse, () =>
    publishNativeLocalRefreshFailure(
      sparse.paths,
      {
        ...sparse.event,
        status: 'failed',
        persisted: false,
        failure: { kind: 'validation', classification: 'transient' },
      },
      policy,
    ),
  )
  const event = await savedSuccessor(f)
  if (event.status !== 'persisted') throw new Error('Missing persisted fixture')
  await refused(f, () =>
    publishNativeLocalRefreshFailure(
      f.paths,
      { ...event, successorFingerprint: 'a'.repeat(64) },
      policy,
    ),
  )
})

for (const status of [400, 403, 429, 500] as const) {
  test(`failure provider status${status} dead-token discriminator is exactly400`, async () => {
    const f = await fixture()
    const event: NativeRefreshObservation = {
      ...f.event,
      status: 'failed',
      persisted: false,
      failure: { kind: 'provider', classification: 'invalid-grant', status },
    }
    const result = await publishNativeLocalRefreshFailure(
      f.paths,
      event,
      status === 400 ? { checkedAt: 100 } : policy,
    )
    expect(result).toMatchObject({
      status: 'published',
      state: {
        accounts: {
          row: { lastRefreshError: { status, permanent: status === 400 } },
        },
      },
    })
  })
}

for (const field of ['identity', 'credentialEpoch', 'missing-row'] as const) {
  test(`failure final guarded binding rejects changed ${field}`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    controls.control.afterSync = async () => {
      const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
      if (field === 'missing-row') config.accounts = []
      else if (field === 'identity')
        config.accounts[0].accountId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      else config.commonAuthPool.rows.row.credentialEpoch = 2
      await writeFile(f.paths.config, JSON.stringify(config), { mode: 0o600 })
    }
    await unchanged(
      f,
      () => runtime.publishNativeLocalRefreshFailure(f.paths, f.event, policy),
      { status: 'superseded', reason: 'row-binding' },
    )
    expect(controls.renames).toBe(0)
  })
}

test('failure cannot repair unidentified runtime from later known pool identity', async () => {
  const f = await fixture()
  const entry = f.runtime.accounts.row!
  const unknownBinding = { ...f.subject.binding, identity: undefined }
  await writeFile(
    f.paths.runtime,
    JSON.stringify({
      ...f.runtime,
      accounts: {
        ...f.runtime.accounts,
        row: { ...entry, binding: unknownBinding },
      },
    }),
    { mode: 0o600 },
  )
  const event = {
    ...f.event,
    context: { ...f.event.context!, runtimeBinding: unknownBinding },
  }
  await unchanged(
    f,
    () => publishNativeLocalRefreshFailure(f.paths, event, policy),
    { status: 'superseded', reason: 'entry-binding' },
  )
})

test('failure retry equal-time conflict and differing access subject ordering', async () => {
  const f = await fixture()
  const event: NativeRefreshObservation = {
    ...f.event,
    status: 'failed',
    persisted: false,
    failure: { kind: 'validation', classification: 'transient' },
  }
  expect(
    await publishNativeLocalRefreshFailure(f.paths, event, policy),
  ).toMatchObject({ status: 'published' })
  await unchanged(
    f,
    () =>
      publishNativeLocalRefreshFailure(f.paths, event, {
        checkedAt: 100,
        nextRetryAt: 300,
      }),
    { status: 'superseded', reason: 'older-than-stored' },
  )
  await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
    const entry = current.accounts.row!
    entry.validationRetry = {
      ...entry.validationRetry!,
      checkedAt: 101,
      subject: {
        ...entry.validationRetry!.subject,
        version: {
          ...entry.validationRetry!.subject.version,
          accessFingerprint: 'a'.repeat(16),
        },
      },
    }
    return current
  })
  expect(
    await publishNativeLocalRefreshFailure(f.paths, event, policy),
  ).toMatchObject({ status: 'published' })
})

test('failure validation retry readers deny matching unexpired access but permit expired exchange', async () => {
  const f = await fixture()
  const event: NativeRefreshObservation = {
    ...f.event,
    status: 'failed',
    persisted: false,
    failure: { kind: 'validation', classification: 'transient' },
  }
  await publishNativeLocalRefreshFailure(f.paths, event, policy)
  const readers = createNativeLocalRuntimeReaders({
    paths: f.paths,
    now: () => 150,
    externalPolicy: () => ({ status: 'allowed' }),
  })
  const result = classifyNativeLocalFailure(event)
  if (result.kind !== 'validation-retry')
    throw new Error('Missing retry subject')
  expect(await readers.readAdmission(result.subject)).toEqual({
    status: 'blocked',
    reason: 'validation-backoff',
  })
  const expired = createNativeLocalRuntimeReaders({
    paths: f.paths,
    now: () => credential.expires,
    externalPolicy: () => ({ status: 'allowed' }),
  })
  expect(await expired.readAdmission(result.subject)).toEqual({
    status: 'unproven',
  })
})

for (const arming of [false, true]) {
  test(`failure caller ${arming ? 'future' : 'non-arming'} deadline respects coordinator retry budget`, async () => {
    const f = await fixture()
    let exchanges = 0
    const readers = createNativeLocalRuntimeReaders({
      paths: f.paths,
      now: () => 100,
      externalPolicy: () => ({ status: 'allowed' }),
    })
    const c = createNativeRefreshCoordinator({
      paths: f.paths,
      quota: nativeQuotaCodec,
      ...readers,
      refreshToken: async () => {
        exchanges++
        throw new ClaudeOAuthRefreshError(500, 'synthetic-provider-body')
      },
      resolveIdentity: async () => {
        throw new Error('Lookup forbidden')
      },
      reconcile: async (event) => {
        expect(
          await publishNativeLocalRefreshFailure(f.paths, event, {
            checkedAt: 100,
            nextRetryAt: arming ? 200 : 100,
          }),
        ).toMatchObject({
          status: event.status === 'failed' ? 'published' : 'skipped',
        })
      },
    })
    expect(
      await c.authorize({
        binding: f.subject.binding,
        intent: 'serve',
        mode: 'local',
        rejectedAccessToken: credential.access,
      }),
    ).toMatchObject(
      arming
        ? { status: 'refused', reason: 'refresh-backoff' }
        : { status: 'failed', failure: { classification: 'transient' } },
    )
    expect(exchanges).toBe(arming ? 1 : 3)
  })
}

// Cancellation must reach an owned child before teardown joins its body. Join
// the process and both pipes individually before fixtures or leases are removed.
function joinOwnedChild(
  child: Pick<Bun.Subprocess, 'exitCode' | 'kill'>,
  lifetime: Pick<TestLifetime, 'gate' | 'trackDetached'>,
  exited: Promise<number>,
  stdout: Promise<string>,
  stderr: Promise<string>,
) {
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
      throw error
    } finally {
      await Promise.allSettled(work)
      cancel.open()
      await cancellation
    }
  })()
  lifetime.trackDetached(
    output.then(
      () => {},
      () => {},
    ),
  )
  return output
}

test('failure owned child publisher performs zero provider HTTP and drains pipes', async () => {
  const f = await fixture({}, true, true)
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { publishNativeLocalRefreshFailure } from ${JSON.stringify(new URL('../native-runtime.ts', import.meta.url).href)};
    let http = 0; globalThis.fetch = async () => { http++; throw new Error('Provider HTTP forbidden'); };
    const result = await publishNativeLocalRefreshFailure(${JSON.stringify(f.paths)}, ${JSON.stringify(f.event)}, ${JSON.stringify(policy)});
    console.log(JSON.stringify({ status: result.status, http }));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const result = await joinOwnedChild(
    child,
    { gate, trackDetached },
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  )
  expect(result).toEqual({
    exit: 0,
    stdout: '{"status":"published","http":0}\n',
    stderr: '',
  })
})

test('failure child cancellation precedes body join and all three drains', async () => {
  const f = await fixture()
  const lifetime = new TestLifetime()
  const entered = Promise.withResolvers<void>()
  const closing = gate()
  trackDetached(closing.wait.then(() => lifetime.finish()))
  let exitSettled = false,
    stdoutSettled = false,
    stderrSettled = false,
    cleanupAfterAll = false
  lifetime.deferCleanup(() => {
    cleanupAfterAll = exitSettled && stdoutSettled && stderrSettled
  })
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { withLock } from ${JSON.stringify(import.meta.resolve('@cortexkit/common-auth/fs'))};
    const paths = ${JSON.stringify(f.paths)};
    await withLock(paths.config, { name: 'pool-config', ttlMs: 10000, timeoutMs: 15000, renew: true }, async () =>
      withLock(paths.state, { name: 'pool-state', ttlMs: 10000, timeoutMs: 15000, renew: true }, async () =>
        withLock(paths.runtime, { name: 'native-runtime', ttlMs: 10000, timeoutMs: 15000, renew: true }, async () => {
          console.log('owned-leases-entered'); setInterval(() => {}, 1000); await new Promise(() => {});
        })));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
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
  trackDetached(body)
  await entered.promise
  closing.open()
  await lifetime.finish()
  const result = await body
  expect(result.stdout).toContain('owned-leases-entered')
  expect(result.exit).not.toBe(0)
  expect(cleanupAfterAll).toBe(true)
  // The killed fixture child cannot release its config and state locks.
  // Remove those owned fixture locks only after the child exits and its
  // stdout and stderr readers finish, so cleanup cannot race active work.
  for (const [path, name] of [
    [f.paths.config, 'pool-config'],
    [f.paths.state, 'pool-state'],
    [f.paths.runtime, 'native-runtime'],
  ])
    await rm(lockPathFor(path!, name!), { force: true })
})

test('failure pool storage faults remain redacted errors not supersession', async () => {
  const f = await fixture()
  await writeFile(f.paths.state, 'synthetic-provider-body not JSON', {
    mode: 0o600,
  })
  await refused(f, () =>
    publishNativeLocalRefreshFailure(f.paths, f.event, policy),
  )
})

test('failure validation retry preserves different-subject proof field-for-field', async () => {
  const f = await fixture({ lastUsed: 9, quotaErrorGeneration: 0 })
  const prior = {
    ...f.subject,
    binding: { ...f.subject.binding, identity: uuid },
    version: { accessFingerprint: 'a'.repeat(16), expires: credential.expires },
  }
  await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
    current.accounts.row!.credentialValidation = prior
    return current
  })
  const event: NativeRefreshObservation = {
    ...f.event,
    status: 'failed',
    persisted: false,
    failure: { kind: 'validation', classification: 'transient' },
  }
  expect(
    await publishNativeLocalRefreshFailure(f.paths, event, policy),
  ).toMatchObject({
    status: 'published',
    state: {
      accounts: {
        row: {
          credentialValidation: prior,
          lastUsed: 9,
          quotaErrorGeneration: 0,
        },
      },
    },
  })
})

for (const field of ['refresh', 'expires', 'lastRefreshedAt'] as const) {
  test(`failure exact full subject rejects changed ${field}`, async () => {
    const f = await fixture()
    await f.store.rotate('row', {
      ...credential,
      ...(field === 'refresh'
        ? { refresh: 'independent-refresh' }
        : field === 'expires'
          ? { expires: credential.expires + 1 }
          : {}),
    })
    const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
    if (field === 'lastRefreshedAt') state.accounts.row.lastRefreshedAt = 0
    else delete state.accounts.row.lastRefreshedAt
    await writeFile(f.paths.state, JSON.stringify(state), { mode: 0o600 })
    await unchanged(
      f,
      () => publishNativeLocalRefreshFailure(f.paths, f.event, policy),
      { status: 'superseded', reason: 'row-credential' },
    )
  })
}

test('failure captured zero reset cannot match a missing runtime floor', async () => {
  const f = await fixture()
  const event = {
    ...f.event,
    context: { ...f.event.context!, refreshErrorClearedAt: 0 },
  }
  await unchanged(
    f,
    () => publishNativeLocalRefreshFailure(f.paths, event, policy),
    { status: 'superseded', reason: 'reset-context' },
  )
})

test('failure stage cleanup storage fault cannot become captured supersession', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  controls.control.afterSync = async () => {
    const config = JSON.parse(await readFile(f.paths.config, 'utf8'))
    config.accounts = []
    await writeFile(f.paths.config, JSON.stringify(config), { mode: 0o600 })
    controls.control.failStageCleanup = true
  }
  const before = await readFile(f.paths.runtime, 'utf8')
  let error: unknown
  try {
    await runtime.publishNativeLocalRefreshFailure(f.paths, f.event, policy)
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({
    name: 'NativeRuntimeError',
    code: 'runtime-io',
  })
  expect(String(error)).not.toContain('synthetic-provider-body')
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
  expect(controls.renames).toBe(0)
  expect(controls.held.size).toBe(0)
})

for (const boundary of [
  'status',
  'credential-version',
  'subject-version',
  'runtime-binding',
  'committed-version',
] as const) {
  test(`failure plain capture rejects ${boundary} accessors without reading or leaking`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    const event: NativeRefreshObservation = structuredClone(
      boundary === 'committed-version' ? await savedSuccessor(f) : f.event,
    )
    let getterReads = 0
    let target: object = event
    let key: string = 'status'
    if (boundary === 'credential-version') {
      target = event.credentialVersion!
      key = 'accessFingerprint'
    }
    if (boundary === 'subject-version') {
      target = event.context!.subject.version
      key = 'expires'
    }
    if (boundary === 'runtime-binding') {
      target = event.context!.runtimeBinding!
      key = 'identity'
    }
    if (boundary === 'committed-version') {
      if (event.status !== 'persisted') throw new Error('Missing saved fixture')
      target = event.committed.version
      key = 'accessFingerprint'
    }
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        getterReads++
        throw new Error('synthetic-bearer-audit-only')
      },
    })
    for (const invoke of [
      () => runtime.classifyNativeLocalFailure(event),
      () => runtime.publishNativeLocalRefreshFailure(f.paths, event, policy),
    ]) {
      let error: unknown
      try {
        await invoke()
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        name: 'NativeRuntimeError',
        code: 'publication-refused',
        message: 'Anthropic runtime publication was refused',
      })
      expect(String(error)).not.toContain('synthetic-bearer-audit-only')
      expect(error instanceof Error && Object.hasOwn(error, 'cause')).toBe(
        false,
      )
      expect(getterReads).toBe(0)
    }
    expect(controls.fileIO).toBe(0)
    expect(controls.events).toEqual([])
    expect(controls.renames).toBe(0)
  })
}

test('failure plain capture closes proxy reflection faults without invoking traps', async () => {
  const f = await fixture()
  let reflections = 0
  const event = new Proxy(f.event, {
    getPrototypeOf() {
      reflections++
      throw new Error('synthetic-bearer-audit-only')
    },
  })
  for (const invoke of [
    () => classifyNativeLocalFailure(event),
    () => publishNativeLocalRefreshFailure(f.paths, event, policy),
  ]) {
    let error: unknown
    try {
      await invoke()
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      name: 'NativeRuntimeError',
      code: 'publication-refused',
    })
    expect(String(error)).not.toContain('synthetic-bearer-audit-only')
  }
  expect(reflections).toBe(0)
})

test('failure classifier malformed actionable plain records stay inside the closed public boundary', async () => {
  const f = await fixture()
  const malformed: unknown[] = [
    null,
    undefined,
    { ...f.event, failure: undefined },
    { ...f.event, failure: null },
    { ...f.event, failure: {} },
    { ...f.event, failure: { kind: null, classification: 'transient' } },
    {
      ...f.event,
      failure: {
        kind: 'provider',
        classification: 'synthetic-bearer-audit-only',
      },
    },
    {
      ...f.event,
      failure: {
        kind: 'provider',
        classification: 'transient',
        status: 'synthetic-bearer-audit-only',
      },
    },
    { ...f.event, persisted: 'synthetic-bearer-audit-only' },
    { ...f.event, context: null },
    { ...f.event, context: 0 },
    { ...f.event, context: 'synthetic-bearer-audit-only' },
    { ...f.event, context: {} },
    { ...f.event, context: { ...f.event.context, subject: null } },
    { ...f.event, context: { ...f.event.context, subject: {} } },
  ]
  const { runtime, controls } = await instrumented(f)
  const alteredNativeError = new runtime.NativeRuntimeError(
    'publication-refused',
  )
  alteredNativeError.message = 'synthetic-bearer-audit-only'
  Object.defineProperty(alteredNativeError, 'cause', {
    value: 'synthetic-bearer-audit-only',
  })
  malformed.push({ ...f.event, failure: alteredNativeError })
  for (const input of malformed) {
    const event = input as NativeRefreshObservation
    for (const invoke of [
      () => runtime.classifyNativeLocalFailure(event),
      () => runtime.publishNativeLocalRefreshFailure(f.paths, event, policy),
    ]) {
      let error: unknown
      try {
        await invoke()
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        name: 'NativeRuntimeError',
        code: 'publication-refused',
        message: 'Anthropic runtime publication was refused',
      })
      expect(String(error)).not.toContain('synthetic-bearer-audit-only')
      expect(error instanceof Error && Object.hasOwn(error, 'cause')).toBe(
        false,
      )
      expect(error).not.toBe(alteredNativeError)
    }
  }
  expect(controls.fileIO).toBe(0)
  expect(controls.events).toEqual([])
  expect(classifyNativeLocalFailure(f.event)).toMatchObject({
    kind: 'refresh-error',
    target: 'captured',
  })
  expect(
    classifyNativeLocalFailure({ ...f.event, context: undefined }),
  ).toEqual({ kind: 'none', reason: 'no-context' })
  expect(
    classifyNativeLocalFailure({
      ...f.event,
      status: 'failed',
      persisted: false,
      failure: { kind: 'caller-hook', classification: 'permanent' },
    }),
  ).toEqual({ kind: 'none', reason: 'not-attributable' })
})
