import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  captureNativeLocalPoolBinding,
  isNativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
  nativeLocalRefreshJobKey,
} from '../pool-binding.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'

const roots: string[] = []

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-pool-binding-')),
  )
  roots.push(root)
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const store = createNativePoolStore({
    paths,
    quota: { validate: () => true, merge: (_, value) => value },
  })
  await store.add({
    id: 'a',
    identity: 'account-a',
    credential: {
      type: 'oauth',
      access: 'synthetic-access',
      refresh: 'synthetic-refresh',
      expires: 4_000_000_000_000,
    },
  })
  return { paths, store }
}

async function row(store: ReturnType<typeof createNativePoolStore>) {
  const loaded = await store.read()
  if (loaded.status !== 'ready' || !loaded.rows[0])
    throw new Error('Expected fixture row')
  return loaded.rows[0]
}

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('capture copies and freezes ownership before the selected row changes', async () => {
  const { paths, store } = await fixture()
  const selected = await row(store)
  const binding = captureNativeLocalPoolBinding(paths, selected)
  expect(Object.isFrozen(binding)).toBe(true)
  expect(binding.identity).toBe('account-a')
  selected.identity = 'account-b'
  expect(binding.identity).toBe('account-a')
  expect(nativeLocalPoolBindingMatches(binding, paths, selected)).toBe(false)
  expect(() => Object.assign(binding, { identity: 'account-b' })).toThrow(
    TypeError,
  )
  expect(Object.keys(binding).sort()).toEqual([
    'credentialEpoch',
    'identity',
    'kind',
    'rowId',
    'storageId',
  ])
})

test('same-account rotation retains ownership while replacement and namespace changes do not', async () => {
  const { paths, store } = await fixture()
  const binding = captureNativeLocalPoolBinding(paths, await row(store))
  const key = nativeLocalRefreshJobKey(binding)
  await store.rotate('a', {
    type: 'oauth',
    access: 'rotated-access',
    refresh: 'rotated-refresh',
    expires: 4_000_000_000_001,
  })
  expect(nativeLocalPoolBindingMatches(binding, paths, await row(store))).toBe(
    true,
  )
  expect(
    nativeLocalRefreshJobKey(
      captureNativeLocalPoolBinding(paths, await row(store)),
    ),
  ).toBe(key)
  const other = await fixture()
  expect(
    nativeLocalPoolBindingMatches(binding, other.paths, await row(other.store)),
  ).toBe(false)
  await store.replace(
    'a',
    {
      type: 'oauth',
      access: 'replacement-access',
      refresh: 'replacement-refresh',
      expires: 4_000_000_000_002,
    },
    { identity: 'account-b' },
  )
  expect(nativeLocalPoolBindingMatches(binding, paths, await row(store))).toBe(
    false,
  )
})

test('a disabled row still owns its completed observation but cannot issue a new serving capture', async () => {
  const { paths, store } = await fixture()
  const binding = captureNativeLocalPoolBinding(paths, await row(store))
  await store.disable('a', 'user')
  const disabled = await row(store)
  expect(nativeLocalPoolBindingMatches(binding, paths, disabled)).toBe(true)
  expect(() => captureNativeLocalPoolBinding(paths, disabled)).toThrow(
    'binding is unavailable',
  )
  for (const change of [
    { stamp: 'missing' },
    { torn: true },
    { unbound: true },
    { invalid: 'entry' },
    { credentialEpoch: 0 },
    { credentialEpoch: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(
      nativeLocalPoolBindingMatches(binding, paths, { ...disabled, ...change }),
    ).toBe(false)
    expect(() =>
      captureNativeLocalPoolBinding(paths, {
        ...disabled,
        ...change,
        candidate: true,
      }),
    ).toThrow('binding is unavailable')
  }
})

test('refresh keys separate unknown row ids from proven identities, storage pairs and epochs', async () => {
  const { paths, store } = await fixture()
  const known = captureNativeLocalPoolBinding(paths, await row(store))
  const knownKey = nativeLocalRefreshJobKey(known)
  const unknown = {
    kind: 'local' as const,
    storageId: known.storageId,
    rowId: 'account-a',
    credentialEpoch: known.credentialEpoch,
  }
  expect(nativeLocalRefreshJobKey(unknown)).not.toBe(knownKey)
  expect(nativeLocalRefreshJobKey({ ...known, rowId: 'alias' })).toBe(knownKey)
  expect(
    nativeLocalPoolBindingMatches(
      { ...known, rowId: 'alias' },
      paths,
      await row(store),
    ),
  ).toBe(false)
  expect(
    nativeLocalRefreshJobKey({
      ...known,
      credentialEpoch: known.credentialEpoch + 1,
    }),
  ).not.toBe(knownKey)
  const other = await fixture()
  expect(
    nativeLocalRefreshJobKey({ ...known, storageId: other.paths.storageId }),
  ).not.toBe(knownKey)
})

test('runtime binding validation rejects secret fields, malformed epochs and custody shapes', async () => {
  const { paths, store } = await fixture()
  const binding = captureNativeLocalPoolBinding(paths, await row(store))
  expect(isNativeLocalPoolBinding(binding)).toBe(true)
  for (const value of [
    null,
    [],
    { ...binding, access: 'synthetic-secret' },
    { ...binding, credentialEpoch: 1.5 },
    { ...binding, credentialEpoch: Number.NaN },
    { ...binding, storageId: 'not-a-storage-id' },
    { ...binding, identity: '' },
    { ...binding, kind: 'claustrum' },
  ]) {
    expect(isNativeLocalPoolBinding(value)).toBe(false)
  }
})

test('explicit same-identity replacement still revokes the prior credential epoch', async () => {
  const { paths, store } = await fixture()
  const binding = captureNativeLocalPoolBinding(paths, await row(store))
  await store.replace(
    'a',
    {
      type: 'oauth',
      access: 'replacement-access',
      refresh: 'replacement-refresh',
      expires: 4_000_000_000_002,
    },
    { identity: 'account-a' },
  )
  const replacement = await row(store)
  expect(replacement.identity).toBe(binding.identity)
  expect(replacement.credentialEpoch).toBe(binding.credentialEpoch + 1)
  expect(nativeLocalPoolBindingMatches(binding, paths, replacement)).toBe(false)
})
