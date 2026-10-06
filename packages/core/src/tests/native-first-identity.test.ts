import { expect } from 'bun:test'
import { watch } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lockPathFor, withLock } from '@cortexkit/common-auth/fs'
import {
  fingerprintOf,
  openPoolStore,
  POOL_LOCK_DEFAULTS,
} from '@cortexkit/common-auth/store'

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
  publishNativeLocalFirstIdentity,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'
import {
  captureNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
} from '../pool-binding.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const otherUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const credential = {
  type: 'oauth' as const,
  access: 'synthetic-access',
  refresh: 'synthetic-refresh',
  expires: 4_000_000_000_000,
}

async function fixture(
  known = true,
  metadata: Partial<NativeRuntimeEntry> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'native-first-identity-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'config.json'),
    join(root, 'state.json'),
  )
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  await store.add({
    id: 'row',
    credential,
    ...(known ? { identity: uuid } : {}),
  })
  const read = await store.read()
  if (read.status !== 'ready' || !read.rows[0])
    throw new Error('Missing fixture row')
  const row = read.rows[0]
  const binding = captureNativeLocalPoolBinding(paths, row)
  const predecessor: NativeLocalPoolBinding = {
    kind: 'local',
    storageId: paths.storageId,
    rowId: 'row',
    credentialEpoch: binding.credentialEpoch,
  }
  const runtime = await updateNativeRuntime(
    paths.runtime,
    paths.storageId,
    () => ({
      version: 1,
      storageId: paths.storageId,
      relay: { token: 'synthetic-relay' },
      accounts: {
        row: { binding: predecessor, ...metadata },
        unrelated: {
          binding: { ...predecessor, rowId: 'unrelated', identity: otherUuid },
          lastUsed: 5,
        },
      },
    }),
  )
  const c = row.credential
  if (c?.type !== 'oauth' || !c.access || !c.expires)
    throw new Error('Missing OAuth fixture')
  const subject: NativeRefreshSubject = {
    binding,
    credentialFingerprint: fingerprintOf(c),
    version: {
      accessFingerprint: tokenFingerprint(c.access),
      expires: c.expires,
      ...(Object.hasOwn(c, 'lastRefreshedAt')
        ? { lastRefreshedAt: c.lastRefreshedAt }
        : {}),
    },
  }
  const context = {
    subject,
    runtimeBinding: predecessor,
    refreshErrorClearedAt: metadata.refreshErrorClearedAt ?? null,
    quotaErrorClearedAt: metadata.quotaErrorClearedAt ?? null,
    quotaErrorGeneration: metadata.quotaErrorGeneration ?? null,
  }
  const event: NativeRefreshObservation = {
    status: 'persisted',
    binding,
    identity: uuid,
    bootstrap: 'resolved',
    handoff: 'not-needed',
    attempt: 1,
    credentialFingerprint: subject.credentialFingerprint,
    credentialVersion: subject.version,
    context,
    successorFingerprint: subject.credentialFingerprint,
    successorVersion: subject.version,
    committed: {
      credentialFingerprint: subject.credentialFingerprint,
      version: subject.version,
    },
  }
  return { root, paths, store, predecessor, subject, event, runtime }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function proof(f: Fixture): NativeLocalCredentialValidation {
  return {
    binding: { ...f.predecessor, identity: uuid },
    credentialFingerprint: f.subject.credentialFingerprint,
    version: {
      accessFingerprint: tokenFingerprint(credential.access),
      expires: credential.expires,
      ...f.subject.version,
    },
  }
}

async function refused(
  f: Fixture,
  event: unknown = f.event,
  code = 'publication-refused',
  publisher = publishNativeLocalFirstIdentity,
) {
  const before = await readFile(f.paths.runtime, 'utf8')
  try {
    await publisher(f.paths, event as NativeRefreshObservation)
    throw new Error('Refusal did not occur')
  } catch (error) {
    expect(error).toMatchObject({ name: 'NativeRuntimeError', code })
    expect(String(error)).not.toContain('synthetic-access')
    expect(String(error)).not.toContain('synthetic-refresh')
  }
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
  expect(
    (await readdir(f.root)).filter((name) =>
      isNativeRuntimeStagingName(f.paths.runtime, name),
    ),
  ).toEqual([])
}

test('first identity metadata reset keeps exact floors generation and unrelated state', async () => {
  const f = await fixture(true, {
    lastUsed: 1,
    lastRefreshedAt: 2,
    lastRefreshError: { message: 'old refresh', checkedAt: 11 },
    refreshErrorClearedAt: 0,
    lastQuotaRefreshError: { message: 'old quota', checkedAt: 13 },
    quotaErrorClearedAt: 3,
    quotaErrorGeneration: 7,
    refreshLeaseId: 'old-lease',
    refreshLeaseUntil: 99,
    refreshLeaseTokenHash: 'a'.repeat(64),
    profile: { tier: 'max', orgType: 'team', checkedAt: 5 },
    prime: { count: 1, inputTokens: 2, outputTokens: 3, since: 4 },
    authLineageId: 'old-lineage',
    primeAuthLineageRefreshTokenFingerprint: tokenFingerprint('old-refresh'),
    quotaCheckedAt: 6,
    quotaToken: tokenFingerprint('old-access'),
  })
  const next = await publishNativeLocalFirstIdentity(f.paths, f.event)
  expect(next.accounts.row).toEqual({
    binding: proof(f).binding,
    credentialValidation: proof(f),
    refreshErrorClearedAt: 11,
    quotaErrorClearedAt: 13,
    quotaErrorGeneration: 7,
  })
  expect(next.accounts.unrelated).toEqual(f.runtime.accounts.unrelated)
  expect(next.relay).toEqual(f.runtime.relay)
  expect(Object.keys(next.accounts)).toEqual(['row', 'unrelated'])
  expect(await readNativeRuntime(f.paths.runtime, f.paths.storageId)).toEqual({
    status: 'ready',
    state: next,
  })
})

test('first identity preserves absent versus zero fences without generation bump', async () => {
  for (const metadata of [
    {},
    {
      refreshErrorClearedAt: 0,
      quotaErrorClearedAt: 0,
      quotaErrorGeneration: 0,
    },
    { refreshErrorClearedAt: 20, quotaErrorGeneration: 9 },
  ]) {
    const f = await fixture(true, metadata)
    expect(
      (await publishNativeLocalFirstIdentity(f.paths, f.event)).accounts.row,
    ).toEqual({
      binding: proof(f).binding,
      credentialValidation: proof(f),
      ...metadata,
    })
  }
})

test('first identity permits sparse original dispatch but never sparse checked successor', async () => {
  for (const version of [
    {},
    { accessFingerprint: undefined, expires: undefined },
  ]) {
    const f = await fixture()
    const event = structuredClone(f.event)
    if (!event.context) throw new Error('Fixture context')
    event.binding = f.predecessor
    event.credentialVersion = version
    event.context = {
      ...event.context,
      subject: {
        binding: f.predecessor,
        credentialFingerprint: f.subject.credentialFingerprint,
        version,
      },
    }
    expect(
      (await publishNativeLocalFirstIdentity(f.paths, event)).accounts.row
        ?.credentialValidation,
    ).toEqual(proof(f))
  }
})

test('first identity requires known captured subject for validation observation', async () => {
  const f = await fixture()
  if (!f.event.context) throw new Error('Fixture context')
  const event = {
    ...f.event,
    status: 'validation-observed' as const,
    identity: uuid,
    context: f.event.context,
  }
  await refused(f, {
    ...event,
    binding: f.predecessor,
    context: {
      ...event.context,
      subject: { ...f.subject, binding: f.predecessor },
    },
  })
  await refused(f, { ...event, bootstrap: 'unavailable' })
  await publishNativeLocalFirstIdentity(f.paths, event)
})

test('first identity refuses known identity clearing and retargeting observations', async () => {
  const f = await fixture()
  await writeFile(
    f.paths.runtime,
    JSON.stringify({
      ...f.runtime,
      accounts: {
        ...f.runtime.accounts,
        row: { binding: { ...f.predecessor, identity: uuid } },
      },
    }),
    { mode: 0o600 },
  )
  for (const identity of [undefined, otherUuid, uuid]) {
    await refused(f, { ...f.event, identity })
  }
})

test('first identity rejects changed or incoherent current pool bindings', async () => {
  for (const variant of [
    'epoch',
    'identity',
    'missing',
    'kind',
    'unbound',
    'malformed',
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
    if (variant === 'malformed')
      await writeFile(f.paths.config, '{"secret":"synthetic-refresh",', {
        mode: 0o600,
      })
    await refused(f)
  }
})

test('first identity attributes a disabled bound row without granting serving eligibility', async () => {
  const f = await fixture()
  await f.store.disable('row', 'synthetic-disable')
  const next = await publishNativeLocalFirstIdentity(f.paths, f.event)
  expect(next.accounts.row?.credentialValidation).toEqual(proof(f))
  const read = await f.store.read()
  expect(read.status === 'ready' && read.rows[0]?.enabled).toBe(false)
})

test('first identity refuses ineligible and incomplete observations', async () => {
  const f = await fixture()
  const base = f.event
  const negatives: unknown[] = [
    null,
    {},
    ...['failed', 'adopted', 'refused', 'identity-contradicted'].map(
      (status) => ({ ...base, status }),
    ),
  ]
  for (const bootstrap of ['failed', 'unavailable'])
    negatives.push({ ...base, bootstrap })
  for (const identity of [undefined, '', 'not-a-uuid', otherUuid])
    negatives.push({ ...base, identity })
  negatives.push(
    { ...base, context: undefined },
    { ...base, committed: undefined },
    { ...base, successorVersion: {} },
    {
      ...base,
      committed: {
        credentialFingerprint: f.subject.credentialFingerprint,
        version: {},
      },
    },
  )
  if (base.status !== 'persisted') throw new Error('Fixture status')
  negatives.push(
    { ...base, successorFingerprint: 'b'.repeat(64) },
    {
      ...base,
      committed: { ...base.committed, credentialFingerprint: 'b'.repeat(64) },
    },
  )
  for (const key of ['accessFingerprint', 'expires', 'lastRefreshedAt'])
    negatives.push({
      ...base,
      committed: {
        ...base.committed,
        version: {
          ...base.committed.version,
          [key]:
            key === 'accessFingerprint' ? tokenFingerprint('other-access') : 0,
        },
      },
    })
  for (const event of negatives) await refused(f, event)
  await publishNativeLocalFirstIdentity(f.paths, f.event)
})

test('first identity exact version rejects every material mismatch and timestamp presence direction', async () => {
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
    if (event.status !== 'persisted') throw new Error('Fixture status')
    const version = { ...event.successorVersion }
    if (variant === 'refresh')
      event.successorFingerprint = fingerprintOf({
        type: 'oauth',
        refresh: 'other-refresh',
      })
    if (variant === 'access')
      version.accessFingerprint = tokenFingerprint('other-access')
    if (variant === 'expires') version.expires = credential.expires - 1
    if (variant === 'stamp-zero') version.lastRefreshedAt = 0
    if (variant === 'stamp-value') version.lastRefreshedAt = 10
    if (variant === 'stamp-absent') {
      // Change only the presence of lastRefreshedAt in saved credential state,
      // retaining the same credential epoch.
      const state = JSON.parse(await readFile(f.paths.state, 'utf8'))
      state.accounts.row.lastRefreshedAt = 0
      await writeFile(f.paths.state, JSON.stringify(state), { mode: 0o600 })
    }
    event.successorVersion = version
    event.committed = {
      credentialFingerprint: event.successorFingerprint,
      version,
    }
    await refused(f, event)
  }
})

test('first identity reset context rejects binding clear and generation drift', async () => {
  for (const key of [
    'refreshErrorClearedAt',
    'quotaErrorClearedAt',
    'quotaErrorGeneration',
  ]) {
    for (const [captured, current] of [
      [null, 0],
      [0, null],
      [1, 2],
    ]) {
      const f = await fixture(true, current === null ? {} : { [key]: current })
      const event = structuredClone(f.event)
      if (!event.context) throw new Error('Fixture context')
      event.context = { ...event.context, [key]: captured }
      await refused(f, event)
    }
  }
  const f = await fixture()
  for (const changed of [
    { rowId: 'elsewhere' },
    { storageId: 'b'.repeat(64) },
    { credentialEpoch: 2 },
    { identity: uuid },
    { kind: 'custody' },
  ]) {
    const event = structuredClone(f.event)
    await refused(f, {
      ...event,
      context: {
        ...event.context,
        runtimeBinding: { ...f.predecessor, ...changed },
      },
    })
  }
})

test('first identity refuses missing known custody alternate row storage and epoch predecessors', async () => {
  for (const variant of [
    'missing',
    'known',
    'custody',
    'row',
    'storage',
    'epoch',
  ]) {
    const f = await fixture()
    await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
      const old = current.accounts.row
      if (!old) throw new Error('Fixture predecessor')
      if (variant === 'missing') delete current.accounts.row
      if (variant === 'known')
        old.binding = { ...f.predecessor, identity: otherUuid }
      if (variant === 'custody')
        old.binding = {
          kind: 'custody',
          storageId: f.paths.storageId,
          routeId: 'row',
          credentialId: 'cred',
          accountIdentity: uuid,
          recordVersion: 1,
        }
      if (variant === 'row') {
        delete current.accounts.row
        current.accounts.alternate = {
          binding: { ...f.predecessor, rowId: 'alternate' },
        }
      }
      if (variant === 'epoch')
        old.binding = { ...f.predecessor, credentialEpoch: 2 }
      return current
    }).catch(async (error) => {
      // This runtime entry has no account UUID. A generic write cannot establish
      // that identity at the same epoch because it has no checked pool observation.
      if (variant !== 'known') throw error
      const state = structuredClone(f.runtime)
      state.accounts.row = {
        binding: { ...f.predecessor, identity: otherUuid },
      }
      await writeFile(f.paths.runtime, JSON.stringify(state), { mode: 0o600 })
    })
    if (variant === 'storage') {
      const state = structuredClone(f.runtime)
      state.accounts.row = {
        binding: { ...f.predecessor, storageId: 'b'.repeat(64) },
      }
      await writeFile(f.paths.runtime, JSON.stringify(state), { mode: 0o600 })
    }
    await refused(
      f,
      f.event,
      variant === 'storage' ? 'invalid-runtime' : 'publication-refused',
    )
  }
})

test('first identity refuses absent runtime without creating a predecessor', async () => {
  const f = await fixture()
  await rm(f.paths.runtime)
  await expect(
    publishNativeLocalFirstIdentity(f.paths, f.event),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  expect(await readNativeRuntime(f.paths.runtime, f.paths.storageId)).toEqual({
    status: 'missing',
  })
  expect(
    (await readdir(f.root)).filter((name) =>
      isNativeRuntimeStagingName(f.paths.runtime, name),
    ),
  ).toEqual([])
})

test('first identity refuses fractional and unsafe clear floors rather than rounding', async () => {
  for (const checkedAt of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ['lastRefreshError', 'lastQuotaRefreshError']) {
      const f = await fixture(true, {
        [key]: { message: 'old error', checkedAt },
      })
      await refused(f)
    }
  }
})

test('first identity strict decoder refuses invalid predecessor proof retry and quota metadata', async () => {
  for (const metadata of [
    { credentialValidation: {} },
    { validationRetry: {} },
    { quota: {} },
    { profileToken: tokenFingerprint('old') },
    { quotaErrorGeneration: -1 },
  ]) {
    const f = await fixture()
    const state = {
      ...f.runtime,
      accounts: {
        ...f.runtime.accounts,
        row: { binding: f.predecessor, ...metadata },
      },
    }
    await writeFile(f.paths.runtime, JSON.stringify(state), { mode: 0o600 })
    await refused(f, f.event, 'invalid-runtime')
  }
})

// Owned module copies expose test controls without adding production knobs or
// replacing Bun's global module registry. Every lease and rename still uses the
// installed implementation; instrumentation observes or disrupts real files.
async function instrumented(
  f: Fixture,
  rewrite: (source: string) => string = (source) => source,
) {
  const directory = join(f.root, 'instrumentation')
  await mkdir(directory)
  const sourcePath = new URL('../native-runtime.ts', import.meta.url)
  let source = rewrite(await readFile(sourcePath, 'utf8'))
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
  const storeUrl = new URL('../pool-store.ts', import.meta.url).href
  await writeFile(
    join(directory, 'controls.ts'),
    `
import * as fs from 'node:fs/promises';
import { withLock as realLock } from ${JSON.stringify(import.meta.resolve('@cortexkit/common-auth/fs'))};
import { createNativePoolStore as realStore, nativePoolStoreLocks } from ${JSON.stringify(storeUrl)};
export { nativePoolStoreLocks };
export const events = []; export const held = new Set(); export const heldAtRenames = [];
export let reads = 0; export let renames = 0; export let forbidden = 0;
export const control = { afterSync: async () => {}, afterRename: async () => {}, afterAcquire: async () => {} };
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
  events.push('rename'); renames++; heldAtRenames.push([...held]);
  await fs.rename(...args); await control.afterRename();
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
    forbidden++; throw new Error('Only strict read is allowed during publication');
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
      afterRename: () => Promise<void>
      afterAcquire: (name: string) => Promise<void>
    }
  } = await import(pathToFileURL(join(directory, 'controls.ts')).href)
  return {
    runtime,
    controls,
    moduleUrl: pathToFileURL(join(directory, 'runtime.ts')).href,
    controlsUrl: pathToFileURL(join(directory, 'controls.ts')).href,
  }
}

test('first identity real leases acquire config state runtime once and hold through one rename', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  const beforePool = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  const next = await runtime.publishNativeLocalFirstIdentity(f.paths, f.event)
  expect(next.accounts.row?.credentialValidation).toEqual(proof(f))
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
  expect(controls.reads).toBe(2)
  expect(controls.renames).toBe(1)
  expect(controls.heldAtRenames).toEqual([
    ['pool-config', 'pool-state', 'native-runtime'],
  ])
  expect(controls.forbidden).toBe(0)
  expect(controls.held.size).toBe(0)
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(beforePool)
})

test('first identity authorization still runs generic error transition fences', async () => {
  const f = await fixture(true, {
    lastRefreshError: { message: 'old-error', checkedAt: 5 },
  })
  const { runtime, controls } = await instrumented(f, (source) => {
    const removed =
      '...(refreshErrorClearedAt !== undefined ? { refreshErrorClearedAt } : {}),'
    expect(source).toContain(removed)
    return source.replace(removed, '')
  })
  await refused(
    f,
    f.event,
    'runtime-conflict',
    runtime.publishNativeLocalFirstIdentity,
  )
  expect(controls.renames).toBe(0)
})

for (const name of ['pool-config', 'pool-state', 'native-runtime']) {
  test(`first identity refuses actual ${name} lease loss with no stage leak`, async () => {
    const f = await fixture()
    const { runtime, controls } = await instrumented(f)
    const before = await readFile(f.paths.runtime, 'utf8')
    controls.control.afterSync = async () => {
      const path =
        name === 'pool-config'
          ? f.paths.config
          : name === 'pool-state'
            ? f.paths.state
            : f.paths.runtime
      await rm(lockPathFor(path, name))
    }
    let error: unknown
    try {
      await runtime.publishNativeLocalFirstIdentity(f.paths, f.event)
    } catch (caught) {
      error = caught
    }
    // Observe publication before checking its error classification, so removing
    // a production lease assertion fails on the unsafe rename itself.
    expect(controls.renames).toBe(0)
    expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
    expect(
      (await readdir(f.root)).filter((leaf) =>
        isNativeRuntimeStagingName(f.paths.runtime, leaf),
      ),
    ).toEqual([])
    expect(error).toMatchObject({
      name: 'NativeRuntimeError',
      code: name === 'native-runtime' ? 'runtime-io' : 'publication-refused',
    })
    expect(controls.held.size).toBe(0)
  })
}

test('first identity final strict version recheck rejects access-only same-epoch replacement', async () => {
  const f = await fixture()
  const { runtime, controls } = await instrumented(f)
  const oldState = await readFile(f.paths.state, 'utf8')
  const oldConfig = await readFile(f.paths.config, 'utf8')
  // Prepare a valid credential-bound replacement through the store before taking
  // publication locks. Inject its saved bytes later to simulate an external stale
  // writer changing access without invoking a store operation under those locks.
  await f.store.rotate('row', { ...credential, access: 'intervening-access' })
  const replacement = JSON.parse(await readFile(f.paths.state, 'utf8'))
  delete replacement.accounts.row.lastRefreshedAt
  await writeFile(f.paths.state, oldState, { mode: 0o600 })
  await writeFile(f.paths.config, oldConfig, { mode: 0o600 })
  controls.control.afterSync = async () => {
    await writeFile(f.paths.state, JSON.stringify(replacement), { mode: 0o600 })
    const read = await f.store.read()
    expect(read.status === 'ready' && read.rows[0]?.stamp).toBe('bound')
    expect(read.status === 'ready' && read.rows[0]?.credentialEpoch).toBe(
      f.predecessor.credentialEpoch,
    )
  }
  await refused(
    f,
    f.event,
    'publication-refused',
    runtime.publishNativeLocalFirstIdentity,
  )
  expect(controls.reads).toBe(2)
  expect(controls.renames).toBe(0)
})

test('first identity copies checked proof and context before lock waits', async () => {
  const f = await fixture()
  const event = structuredClone(f.event)
  const { runtime, controls } = await instrumented(f)
  controls.control.afterAcquire = async (name) => {
    if (name !== 'pool-config') return
    if (event.status !== 'persisted' || !event.context)
      throw new Error('Fixture event')
    event.successorVersion = {}
    event.context = { ...event.context, quotaErrorGeneration: 100 }
  }
  expect(
    (await runtime.publishNativeLocalFirstIdentity(f.paths, event)).accounts.row
      ?.credentialValidation,
  ).toEqual(proof(f))
})

test('strict native reader under both production pool leases performs zero writes pulls or HTTP', async () => {
  const f = await fixture()
  const specs = nativePoolStoreLocks(f.paths)
  let writes = 0
  let pulls = 0
  const watcher = watch(f.root, (_event, leaf) => {
    if (
      leaf === f.paths.config.split('/').at(-1) ||
      leaf === f.paths.state.split('/').at(-1)
    )
      writes++
  })
  deferCleanup(() => watcher.close())
  const before = await Promise.all(
    [f.paths.config, f.paths.state].map(async (path) => ({
      bytes: await readFile(path, 'utf8'),
      info: await stat(path),
    })),
  )
  const observable = openPoolStore({
    provider: 'anthropic',
    configPath: f.paths.config,
    statePath: f.paths.state,
    requireCredentialStamps: true,
    storeLocks: specs,
    quota: nativeQuotaCodec,
    pull: async () => {
      pulls++
      throw new Error('Pull forbidden')
    },
  })
  await withLock(
    specs[0].path,
    { ...POOL_LOCK_DEFAULTS, name: specs[0].name },
    async (config) =>
      withLock(
        specs[1].path,
        { ...POOL_LOCK_DEFAULTS, name: specs[1].name },
        async (state) => {
          expect(await f.store.read()).toEqual(await observable.read())
          await observable.pullsSettled()
          await config.assertOwned()
          await state.assertOwned()
        },
      ),
  )
  expect(pulls).toBe(0)
  const after = await Promise.all(
    [f.paths.config, f.paths.state].map(async (path) => ({
      bytes: await readFile(path, 'utf8'),
      info: await stat(path),
    })),
  )
  expect(
    after.map(({ bytes, info }) => [
      bytes,
      info.ino,
      info.mtimeMs,
      info.ctimeMs,
    ]),
  ).toEqual(
    before.map(({ bytes, info }) => [
      bytes,
      info.ino,
      info.mtimeMs,
      info.ctimeMs,
    ]),
  )
  expect(writes).toBe(0)
  // Intercept fetch only in the child to count unexpected HTTP attempts while
  // createNativePoolStore.read follows the installed strict pool-file read path.
  const result = await child(`
    import { withLock } from ${JSON.stringify(import.meta.resolve('@cortexkit/common-auth/fs'))};
    import { createNativePoolStore } from ${JSON.stringify(new URL('../pool-store.ts', import.meta.url).href)};
    import { nativeQuotaCodec } from ${JSON.stringify(new URL('../native-quota-codec.ts', import.meta.url).href)};
    let http = 0; globalThis.fetch = async () => { http++; throw new Error('HTTP forbidden'); };
    const paths = ${JSON.stringify(f.paths)};
    await withLock(paths.config, { name: 'pool-config', ttlMs: 10000, timeoutMs: 15000, renew: true }, async a => withLock(paths.state, { name: 'pool-state', ttlMs: 10000, timeoutMs: 15000, renew: true }, async b => {
      const read = await createNativePoolStore({ paths, quota: nativeQuotaCodec }).read();
      await a.assertOwned(); await b.assertOwned(); console.log(JSON.stringify({ status: read.status, http }));
    }));
  `)
  expect(result.exit).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ status: 'ready', http: 0 })
  expect(result.stderr).toBe('')
})

async function child(source: string) {
  const process = Bun.spawn([globalThis.process.execPath, '-e', source], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  trackDetached(output)
  deferCleanup(() => {
    if (process.exitCode === null) process.kill()
  })
  const [exit, stdout, stderr] = await output
  return { exit, stdout, stderr }
}

async function expireExitedLeases(f: Fixture) {
  // Expire dead lock records only after confirmed child exit and both output
  // pipes have drained. Those abandoned markers then belong to an exited
  // process, not to a test body that could still be writing its files.
  for (const [path, name] of [
    ...nativePoolStoreLocks(f.paths).map((s) => [s.path, s.name] as const),
    [f.paths.runtime, 'native-runtime'] as const,
  ]) {
    const markerPath = lockPathFor(path, name)
    try {
      const marker = JSON.parse(await readFile(markerPath, 'utf8'))
      marker.expiresAt = 0
      await writeFile(markerPath, JSON.stringify(marker))
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error
    }
  }
}

test('first identity serialized 0.9.0 learning publishes same epoch exactly once', async () => {
  const f = await fixture(false)
  const { runtime, controls } = await instrumented(f)
  let refreshes = 0
  let lookups = 0
  const coordinator = createNativeRefreshCoordinator({
    paths: f.paths,
    quota: nativeQuotaCodec,
    refreshToken: async () => {
      refreshes++
      return {
        ...credential,
        access: 'new-access',
        refresh: 'new-refresh',
        expiresIn: 3600,
      }
    },
    resolveIdentity: async () => {
      lookups++
      expect(controls.held.size).toBe(0)
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: uuid as ProviderAccountUuid,
      }
    },
    readRestrictions: async (subject) => ({
      restriction: { status: 'allowed' },
      context: {
        subject,
        runtimeBinding: f.predecessor,
        refreshErrorClearedAt: null,
        quotaErrorClearedAt: null,
        quotaErrorGeneration: null,
      },
    }),
    readAdmission: async (subject) => {
      const read = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
      const validation =
        read.status === 'ready'
          ? read.state.accounts.row?.credentialValidation
          : undefined
      return validation &&
        validation.credentialFingerprint === subject.credentialFingerprint
        ? { status: 'proven', validation }
        : { status: 'unproven' }
    },
    reconcile: async (event) => {
      expect(event.status).toBe('persisted')
      await runtime.publishNativeLocalFirstIdentity(f.paths, event)
    },
  })
  const result = await coordinator.authorize({
    binding: f.predecessor,
    intent: 'serve',
    mode: 'local',
  })
  expect(result).toMatchObject({
    status: 'usable',
    source: 'rotated',
    binding: { ...f.predecessor, identity: uuid },
  })
  const read = await f.store.read()
  if (read.status !== 'ready' || !read.rows[0])
    throw new Error('Missing committed row')
  expect(read.rows[0].credentialEpoch).toBe(f.predecessor.credentialEpoch)
  const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  if (saved.status !== 'ready') throw new Error('Missing proof')
  expect(
    nativeLocalCredentialValidationMatches(
      saved.state.accounts.row?.credentialValidation,
      { ...f.predecessor, identity: uuid },
      read.rows[0].credential,
    ),
  ).toBe(true)
  expect(Object.keys(saved.state.accounts.row ?? {})).toEqual([
    'binding',
    'credentialValidation',
  ])
  expect(controls.renames).toBe(1)
  expect(
    controls.events.filter((s) => s === 'acquire:native-runtime'),
  ).toHaveLength(1)
  expect(controls.forbidden).toBe(0)
  expect(refreshes).toBe(1)
  expect(lookups).toBe(1)
})

test('first identity child crash after pool commit recovers with known validation only', async () => {
  const f = await fixture(false)
  const before = await readFile(f.paths.runtime, 'utf8')
  const result = await child(`
    import { createNativeRefreshCoordinator } from ${JSON.stringify(new URL('../native-refresh-coordinator.ts', import.meta.url).href)};
    import { nativeQuotaCodec } from ${JSON.stringify(new URL('../native-quota-codec.ts', import.meta.url).href)};
    const coordinator = createNativeRefreshCoordinator({ paths: ${JSON.stringify(f.paths)}, quota: nativeQuotaCodec,
      refreshToken: async () => (${JSON.stringify({ ...credential, access: 'new-access', refresh: 'new-refresh' })}),
      resolveIdentity: async () => ({ deviceId: 'synthetic', accountUuid: ${JSON.stringify(uuid)} }),
      readRestrictions: async subject => ({ restriction: { status: 'allowed' }, context: { subject, runtimeBinding: ${JSON.stringify(f.predecessor)}, refreshErrorClearedAt: null, quotaErrorClearedAt: null, quotaErrorGeneration: null } }),
      readAdmission: async () => ({ status: 'unproven' }),
      reconcile: async event => { if (event.status !== 'persisted') throw new Error('Expected commit'); process.exit(19); },
    });
    await coordinator.authorize({ binding: ${JSON.stringify(f.predecessor)}, intent: 'serve', mode: 'local' });
  `)
  expect(result.exit).toBe(19)
  expect(result.stderr).toBe('')
  await expireExitedLeases(f)
  expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
  const read = await f.store.read()
  if (read.status !== 'ready' || !read.rows[0])
    throw new Error('Missing committed row')
  const known = captureNativeLocalPoolBinding(f.paths, read.rows[0])
  expect(known).toEqual({ ...f.predecessor, identity: uuid })
  const beforePool = await Promise.all([
    readFile(f.paths.config, 'utf8'),
    readFile(f.paths.state, 'utf8'),
  ])
  let refreshes = 0
  let lookups = 0
  const observations: string[] = []
  const coordinator = createNativeRefreshCoordinator({
    paths: f.paths,
    quota: nativeQuotaCodec,
    refreshToken: async () => {
      refreshes++
      throw new Error('Redundant refresh forbidden')
    },
    resolveIdentity: async () => {
      lookups++
      return {
        deviceId: 'synthetic',
        sessionId: 'synthetic-session',
        accountUuid: uuid as ProviderAccountUuid,
      }
    },
    readRestrictions: async (subject) => ({
      restriction: { status: 'allowed' },
      context: {
        subject,
        runtimeBinding: f.predecessor,
        refreshErrorClearedAt: null,
        quotaErrorClearedAt: null,
        quotaErrorGeneration: null,
      },
    }),
    readAdmission: async () => {
      const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
      const validation =
        saved.status === 'ready'
          ? saved.state.accounts.row?.credentialValidation
          : undefined
      return validation
        ? { status: 'proven', validation }
        : { status: 'unproven' }
    },
    reconcile: async (event) => {
      observations.push(event.status)
      await publishNativeLocalFirstIdentity(f.paths, event)
    },
  })
  expect(
    await coordinator.authorize({
      binding: known,
      intent: 'serve',
      mode: 'local',
    }),
  ).toMatchObject({ status: 'usable', source: 'validated' })
  expect(observations).toEqual(['validation-observed'])
  expect(refreshes).toBe(0)
  expect(lookups).toBe(1)
  expect(
    await Promise.all([
      readFile(f.paths.config, 'utf8'),
      readFile(f.paths.state, 'utf8'),
    ]),
  ).toEqual(beforePool)
})

for (const seam of ['afterSync', 'afterRename']) {
  test(`first identity child interruption ${seam} preserves old or committed proof`, async () => {
    const f = await fixture()
    const { moduleUrl, controlsUrl } = await instrumented(f)
    const before = await readFile(f.paths.runtime, 'utf8')
    const result = await child(`
      const { control } = await import(${JSON.stringify(controlsUrl)});
      control.${seam} = async () => process.exit(19);
      const { publishNativeLocalFirstIdentity } = await import(${JSON.stringify(moduleUrl)});
      await publishNativeLocalFirstIdentity(${JSON.stringify(f.paths)}, ${JSON.stringify(f.event)});
    `)
    expect(result.exit).toBe(19)
    expect(result.stderr).toBe('')
    await expireExitedLeases(f)
    const stages = (await readdir(f.root)).filter((name) =>
      isNativeRuntimeStagingName(f.paths.runtime, name),
    )
    expect(stages).toHaveLength(seam === 'afterSync' ? 1 : 0)
    if (seam === 'afterSync')
      expect(await readFile(f.paths.runtime, 'utf8')).toBe(before)
    else {
      const saved = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
      expect(
        saved.status === 'ready' &&
          saved.state.accounts.row?.credentialValidation,
      ).toEqual(proof(f))
      await refused(f)
    }
  })
}
