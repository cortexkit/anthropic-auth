import { afterEach, expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { toNativeQuotaMap } from '../native-quota-codec.ts'
import {
  decodeNativeRuntime,
  isNativeRuntimeStagingName,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'

const storageId = 'a'.repeat(64)
const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-native-runtime-'))
  roots.push(root)
  return join(root, 'private', 'native-state.json')
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

// The fixture includes both local and vaulted account metadata without OAuth tokens.
const full = {
  version: 1,
  storageId,
  relay: { token: 'synthetic-relay-secret' },
  accounts: {
    'local-row': {
      binding: {
        kind: 'local',
        storageId,
        rowId: 'local-row',
        credentialEpoch: 4,
        identity: 'synthetic-account-A',
      },
      lastUsed: 111,
      lastRefreshedAt: 222,
      lastRefreshError: {
        message: 'synthetic transient failure',
        checkedAt: 333,
        nextRetryAt: 666,
        retryCount: 2,
        accountIdentity: 'synthetic-account-A',
        tokenHash: 'access-hash',
        refreshTokenFingerprint: 'refresh-fingerprint',
        status: 503,
        permanent: false,
      },
      refreshErrorClearedAt: 100,
      refreshLeaseId: 'lease-id',
      refreshLeaseUntil: 777,
      refreshLeaseTokenHash: 'lease-token-hash',
      lastQuotaRefreshError: {
        message: 'synthetic quota failure',
        checkedAt: 555,
        nextRetryAt: 888,
        retryCount: 1,
        accountIdentity: 'synthetic-account-A',
        tokenHash: 'quota-token-hash',
        refreshTokenFingerprint: 'refresh-fingerprint',
        status: 429,
        permanent: false,
      },
      quotaErrorGeneration: 3,
      quotaErrorClearedAt: 444,
      quotaCheckedAt: 234,
      quotaToken: 'quota-observation-fingerprint',
      profile: {
        tier: 'max',
        orgType: 'individual',
        checkedAt: 123,
        accountIdentity: 'synthetic-account-A',
        providerAccountUuid: 'synthetic-account-A',
        tokenFingerprint: 'profile-fingerprint',
      },
      profileToken: 'profile-observation-fingerprint',
      prime: { count: 5, inputTokens: 12345, outputTokens: 678, since: 90 },
      authLineageId: 'prime-lineage',
      primeAuthLineageRefreshTokenFingerprint: 'prime-refresh-fingerprint',
    },
    'vault-route': {
      binding: {
        kind: 'custody',
        storageId,
        routeId: 'vault-route',
        credentialId: 'credential-A',
        accountIdentity: 'synthetic-vault-A',
        recordVersion: 7,
      },
      quota: toNativeQuotaMap({
        accountIdentity: 'synthetic-vault-A',
        checkedAt: 999,
        scoped: [],
        source: 'headers',
        fieldSources: { scoped: 'poll' },
      }),
      profile: {
        tier: 'max',
        orgType: 'team',
        checkedAt: 998,
        accountIdentity: 'synthetic-vault-A',
      },
    },
  },
}

function state(): NativeRuntimeState {
  return decodeNativeRuntime(structuredClone(full), storageId)
}

test('runtime full-field fixture round-trips and accounts for every owned field', async () => {
  const path = await fixture()
  expect(await readNativeRuntime(path, storageId)).toEqual({
    status: 'missing',
  })
  expect<unknown>(
    await updateNativeRuntime(path, storageId, () => state()),
  ).toEqual(full)
  expect<unknown>(await readNativeRuntime(path, storageId)).toEqual({
    status: 'ready',
    state: full,
  })
  expect(Object.keys(full.accounts['local-row']).sort()).toEqual(
    [
      'binding',
      'lastUsed',
      'lastRefreshedAt',
      'lastRefreshError',
      'refreshErrorClearedAt',
      'refreshLeaseId',
      'refreshLeaseUntil',
      'refreshLeaseTokenHash',
      'lastQuotaRefreshError',
      'quotaErrorGeneration',
      'quotaErrorClearedAt',
      'quotaCheckedAt',
      'quotaToken',
      'profile',
      'profileToken',
      'prime',
      'authLineageId',
      'primeAuthLineageRefreshTokenFingerprint',
    ].sort(),
  )
  expect(Object.keys(full.accounts['vault-route']).sort()).toEqual([
    'binding',
    'profile',
    'quota',
  ])
  const text = await readFile(path, 'utf8')
  for (const forbidden of [
    '"access"',
    '"refresh"',
    '"apiKey"',
    '"expires"',
    '"enabled"',
    '"claustrumScopedState"',
  ])
    expect(text).not.toContain(forbidden)
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
})

test('runtime extra-key control rejects unknown root and nested fields', () => {
  const local = full.accounts['local-row']
  const mutations: unknown[] = [
    { ...full, extra: 'synthetic-secret' },
    {
      ...full,
      relay: { token: 'synthetic-relay-secret', url: 'https://invalid' },
    },
    {
      ...full,
      accounts: { 'local-row': { ...local, access: 'synthetic-secret' } },
    },
    {
      ...full,
      accounts: {
        'local-row': {
          ...local,
          binding: { ...local.binding, credential: 'synthetic-secret' },
        },
      },
    },
    {
      ...full,
      accounts: {
        'local-row': { ...local, profile: { ...local.profile, extra: 1 } },
      },
    },
    {
      ...full,
      accounts: {
        'local-row': {
          ...local,
          lastRefreshError: { ...local.lastRefreshError, extra: 1 },
        },
      },
    },
    {
      ...full,
      accounts: {
        'local-row': { ...local, prime: { ...local.prime, enabled: true } },
      },
    },
  ]
  for (const mutation of mutations)
    expect(() => decodeNativeRuntime(mutation, storageId)).toThrow(
      'Anthropic runtime state is invalid',
    )
})

test('runtime versions, missing fields, invalid bindings and attribution fail closed', () => {
  const local = full.accounts['local-row']
  const custody = full.accounts['vault-route']
  const mutations: unknown[] = [
    null,
    [],
    { ...full, version: 2 },
    { version: 1, storageId },
    { ...full, storageId: 'b'.repeat(64) },
    { ...full, accounts: { wrong: local } },
    {
      ...full,
      accounts: {
        'local-row': {
          ...local,
          binding: { ...local.binding, credentialEpoch: 0 },
        },
      },
    },
    {
      ...full,
      accounts: {
        'local-row': {
          ...local,
          binding: { ...local.binding, storageId: 'b'.repeat(64) },
        },
      },
    },
    {
      ...full,
      accounts: {
        'local-row': {
          ...local,
          profile: {
            ...local.profile,
            providerAccountUuid: 'synthetic-account-B',
          },
        },
      },
    },
    {
      ...full,
      accounts: {
        'local-row': {
          ...local,
          lastRefreshError: {
            ...local.lastRefreshError,
            accountIdentity: 'synthetic-account-B',
          },
        },
      },
    },
    {
      ...full,
      accounts: { 'local-row': { ...local, refreshErrorClearedAt: 333 } },
    },
    {
      ...full,
      accounts: {
        'local-row': { ...local, prime: { ...local.prime, inputTokens: -1 } },
      },
    },
    {
      ...full,
      accounts: {
        'vault-route': {
          ...custody,
          binding: { ...custody.binding, recordVersion: -1 },
        },
      },
    },
    {
      ...full,
      accounts: {
        'vault-route': {
          ...custody,
          binding: { ...custody.binding, routeId: 'other' },
        },
      },
    },
    {
      ...full,
      accounts: {
        'vault-route': {
          ...custody,
          quota: toNativeQuotaMap({ accountIdentity: 'synthetic-vault-B' }),
        },
      },
    },
    { ...full, accounts: { 'local-row': { ...local, quota: custody.quota } } },
  ]
  for (const mutation of mutations)
    expect(() => decodeNativeRuntime(mutation, storageId)).toThrow()
})

test('runtime malformed secret-bearing input has redacted diagnostics and remains untouched', async () => {
  const path = await fixture()
  await mkdir(dirname(path), { mode: 0o700 })
  for (const bytes of [
    '{"relay":{"token":"synthetic-parser-secret',
    JSON.stringify({ ...full, secret: 'synthetic-parser-secret' }),
    JSON.stringify({ ...full, version: 0 }),
  ]) {
    await writeFile(path, bytes, { mode: 0o600 })
    await expect(readNativeRuntime(path, storageId)).rejects.toMatchObject({
      code: 'invalid-runtime',
      message: 'Anthropic runtime state is invalid',
    })
    await expect(
      updateNativeRuntime(path, storageId, () => state()),
    ).rejects.toMatchObject({ code: 'invalid-runtime' })
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
})

test('runtime accepts the published custody receipt initial record version zero', () => {
  const zero = structuredClone(full)
  zero.accounts['vault-route'].binding.recordVersion = 0
  expect<unknown>(decodeNativeRuntime(zero, storageId)).toEqual(zero)
})

test('runtime refuses non-owner modes, symlinks, directories and relative paths', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  await chmod(path, 0o644)
  await expect(readNativeRuntime(path, storageId)).rejects.toMatchObject({
    code: 'unsafe-runtime',
  })
  await expect(
    updateNativeRuntime(path, storageId, () => state()),
  ).rejects.toMatchObject({ code: 'unsafe-runtime' })
  await chmod(path, 0o600)
  const link = join(dirname(path), 'link')
  await symlink(path, link)
  await expect(readNativeRuntime(link, storageId)).rejects.toMatchObject({
    code: 'unsafe-runtime',
  })
  await expect(
    readNativeRuntime(dirname(path), storageId),
  ).rejects.toMatchObject({ code: 'unsafe-runtime' })
  await expect(
    readNativeRuntime('relative.json', storageId),
  ).rejects.toMatchObject({ code: 'unsafe-runtime' })
})

test('runtime malformed UTF-8 cannot silently change a persisted relay secret', async () => {
  const path = await fixture()
  await mkdir(dirname(path), { mode: 0o700 })
  const bytes = Buffer.concat([
    Buffer.from(
      `{"version":1,"storageId":"${storageId}","accounts":{},"relay":{"token":"synthetic-`,
    ),
    Buffer.from([0xff]),
    Buffer.from('"}}'),
  ])
  await writeFile(path, bytes, { mode: 0o600 })
  await expect(readNativeRuntime(path, storageId)).rejects.toMatchObject({
    code: 'invalid-runtime',
  })
  expect(await readFile(path)).toEqual(bytes)
})

test('runtime concurrent updates read under its own lock without lost counters', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  await Promise.all(
    Array.from({ length: 12 }, () =>
      updateNativeRuntime(path, storageId, (current) => {
        const local = current.accounts['local-row']
        if (!local?.prime) throw new Error('fixture prime missing')
        local.prime.count += 1
        return current
      }),
    ),
  )
  const read = await readNativeRuntime(path, storageId)
  expect(read.status).toBe('ready')
  if (read.status !== 'ready') throw new Error('runtime missing')
  expect(read.state.accounts['local-row']?.prime?.count).toBe(17)
})

test('runtime hook refusal before rename preserves exact old bytes and removes staging', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = await readFile(path, 'utf8')
  await expect(
    updateNativeRuntime(
      path,
      storageId,
      (current) => ({
        ...current,
        relay: { token: 'synthetic-new-relay-secret' },
      }),
      {
        beforeRename: async () => {
          throw new Error('synthetic-secret-binding-refusal')
        },
      },
    ),
  ).rejects.toMatchObject({
    code: 'publication-refused',
    message: 'Anthropic runtime publication was refused',
  })
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(
    (await readdir(dirname(path))).filter((name) =>
      isNativeRuntimeStagingName(path, name),
    ),
  ).toEqual([])
})

test('runtime afterRename failure reports refusal but never rolls committed new bytes back', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  await expect(
    updateNativeRuntime(
      path,
      storageId,
      (current) => ({
        ...current,
        relay: { token: 'synthetic-new-relay-secret' },
      }),
      {
        afterRename: async () => {
          expect((await readNativeRuntime(path, storageId)).status).toBe(
            'ready',
          )
          throw new Error('synthetic-crash')
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  expect<unknown>(await readNativeRuntime(path, storageId)).toEqual({
    status: 'ready',
    state: { ...full, relay: { token: 'synthetic-new-relay-secret' } },
  })
})

test('runtime clear fences and newer epochs refuse stale writes without disk changes', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  await updateNativeRuntime(path, storageId, (current) => {
    const local = current.accounts['local-row']
    if (!local) throw new Error('fixture row missing')
    delete local.lastQuotaRefreshError
    delete local.lastRefreshError
    local.quotaErrorClearedAt = 600
    local.quotaErrorGeneration = 4
    local.refreshErrorClearedAt = 600
    return current
  })
  const cleared = await readFile(path, 'utf8')
  await expect(
    updateNativeRuntime(path, storageId, () => state()),
  ).rejects.toMatchObject({ code: 'runtime-conflict' })
  expect(await readFile(path, 'utf8')).toBe(cleared)
  await updateNativeRuntime(path, storageId, (current) => {
    current.accounts['local-row'] = {
      binding: {
        kind: 'local',
        storageId,
        rowId: 'local-row',
        credentialEpoch: 5,
        identity: 'synthetic-account-B',
      },
    }
    return current
  })
  const replaced = await readFile(path, 'utf8')
  await expect(
    updateNativeRuntime(path, storageId, () => state()),
  ).rejects.toMatchObject({ code: 'runtime-conflict' })
  expect(await readFile(path, 'utf8')).toBe(replaced)
})

test('runtime staging predicate matches only its own exact partial filename shape', () => {
  const path = '/isolated/native-state.json'
  const own =
    'native-state.json.native-runtime.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.partial'
  expect(isNativeRuntimeStagingName(path, own)).toBe(true)
  for (const name of [
    own.replace('4ccc', '1ccc'),
    own.replace('8ddd', '7ddd'),
    own.replace('.partial', '.tmp'),
    `${own}.bak`,
    `../${own}`,
    `/tmp/${own}`,
    own.replace('native-state.json', 'other.json'),
    own.replace('native-runtime.', ''),
    'native-state.json.native-runtime.short.partial',
    'native-state.json.native-runtime.lock',
    '.DS_Store',
  ])
    expect(isNativeRuntimeStagingName(path, name)).toBe(false)
})

test('runtime custody versions and quota/profile observation clocks cannot regress', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = await readFile(path, 'utf8')
  for (const field of ['version', 'quota', 'profile']) {
    await expect(
      updateNativeRuntime(path, storageId, (current) => {
        const custody = current.accounts['vault-route']
        if (custody?.binding.kind !== 'custody')
          throw new Error('fixture custody missing')
        if (field === 'version') custody.binding.recordVersion = 6
        if (field === 'quota')
          custody.quota = toNativeQuotaMap({
            accountIdentity: 'synthetic-vault-A',
            checkedAt: 998,
            scoped: [],
            source: 'poll',
          })
        if (field === 'profile' && custody.profile)
          custody.profile.checkedAt = 997
        return current
      }),
    ).rejects.toMatchObject({ code: 'runtime-conflict' })
    expect(await readFile(path, 'utf8')).toBe(before)
  }
})

for (const seam of ['beforeRename', 'afterRename']) {
  test(`runtime child crash at ${seam} leaves only old or complete new authority`, async () => {
    const path = await fixture()
    await updateNativeRuntime(path, storageId, () => state())
    const before = await readFile(path, 'utf8')
    const module = new URL('../native-runtime.ts', import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { updateNativeRuntime } from ${JSON.stringify(module)};
      await updateNativeRuntime(${JSON.stringify(path)}, ${JSON.stringify(storageId)}, current => ({ ...current, relay: { token: 'synthetic-child-relay' } }), { ${seam}: async () => process.exit(19) });`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(await child.exited).toBe(19)
    expect(await new Response(child.stderr).text()).toBe('')
    if (seam === 'beforeRename')
      expect(await readFile(path, 'utf8')).toBe(before)
    else
      expect<unknown>(await readNativeRuntime(path, storageId)).toEqual({
        status: 'ready',
        state: { ...full, relay: { token: 'synthetic-child-relay' } },
      })
    const stages = (await readdir(dirname(path))).filter((name) =>
      isNativeRuntimeStagingName(path, name),
    )
    expect(stages.length).toBe(seam === 'beforeRename' ? 1 : 0)
    for (const name of stages) {
      expect((await lstat(join(dirname(path), name))).mode & 0o777).toBe(0o600)
      await rm(join(dirname(path), name))
    }
  })
}
