import { expect, spyOn } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
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
import { fingerprintOf } from '@cortexkit/common-auth/store'

import { hashRefreshToken } from '../accounts.ts'
import { toNativeQuotaMap } from '../native-quota-codec.ts'
import {
  decodeNativeRuntime,
  isNativeRuntimeStagingName,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite, TestLifetime } from './test-lifetime.ts'

const storageId = 'a'.repeat(64)
const vaultAccountIdentity = '11111111-2222-4333-8444-555555555555'
const { test, deferCleanup } = createTestLifetimeSuite()

test('generic runtime writer refuses same-epoch identity changes even with exact proof and hooks', async () => {
  const path = await fixture()
  const unknown = {
    kind: 'local' as const,
    storageId,
    rowId: 'row',
    credentialEpoch: 1,
  }
  const known = { ...unknown, identity: vaultAccountIdentity }
  await updateNativeRuntime(path, storageId, () => ({
    version: 1,
    storageId,
    accounts: { row: { binding: unknown } },
  }))
  const before = await readFile(path, 'utf8')
  let hookCalls = 0
  await expect(
    updateNativeRuntime(
      path,
      storageId,
      (current) => {
        current.accounts.row = {
          binding: known,
          credentialValidation: {
            binding: known,
            credentialFingerprint: fingerprintOf({
              type: 'oauth',
              refresh: 'synthetic-refresh',
            }),
            version: {
              accessFingerprint: tokenFingerprint('synthetic-access'),
              expires: 4_000_000_000_000,
            },
          },
        }
        return current
      },
      {
        beforeRename: async () => {
          hookCalls++
        },
      },
    ),
  ).rejects.toMatchObject({ code: 'runtime-conflict' })
  expect(hookCalls).toBe(0)
  expect(await readFile(path, 'utf8')).toBe(before)
  // Seed an already-known predecessor independently. Without an epoch change,
  // the writer must refuse to clear its account identity and later substitute
  // another account, as well as refusing a direct substitution.
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      storageId,
      accounts: { row: { binding: known } },
    }),
    { mode: 0o600 },
  )
  const knownBytes = await readFile(path, 'utf8')
  for (const destination of [
    unknown,
    { ...known, identity: 'another-account' },
  ]) {
    await expect(
      updateNativeRuntime(path, storageId, (current) => {
        current.accounts.row = { binding: destination }
        return current
      }),
    ).rejects.toMatchObject({ code: 'runtime-conflict' })
    expect(await readFile(path, 'utf8')).toBe(knownBytes)
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-native-runtime-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  return join(root, 'private', 'native-state.json')
}

test('runtime reader accepts owner-only atomic replacement between stat and open', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => ({
    version: 1,
    storageId,
    accounts: {
      row: {
        binding: { kind: 'local', storageId, rowId: 'row', credentialEpoch: 1 },
        lastUsed: 1,
      },
    },
  }))
  const before = await lstat(path)
  const realOpen = fsPromises.open
  let armed = true
  let replacements = 0
  const openSpy = spyOn(fsPromises, 'open').mockImplementation(
    async (openedPath, flags, mode) => {
      if (armed && openedPath === path) {
        armed = false
        await updateNativeRuntime(path, storageId, (state) => {
          const row = state.accounts.row
          if (!row) throw new Error('Expected the seeded runtime row')
          row.lastUsed = 2
          return state
        })
        const after = await lstat(path)
        expect(after.ino).not.toBe(before.ino)
        expect(before.mode & 0o777).toBe(0o600)
        expect(after.mode & 0o777).toBe(0o600)
        expect(after.uid).toBe(before.uid)
        replacements++
      }
      return realOpen(openedPath, flags, mode)
    },
  )
  try {
    await expect(readNativeRuntime(path, storageId)).resolves.toMatchObject({
      status: 'ready',
      state: { accounts: { row: { lastUsed: 2 } } },
    })
    expect(replacements).toBe(1)
  } finally {
    openSpy.mockRestore()
  }
})

for (const replacement of ['permissions', 'symlink'] as const) {
  test(`runtime reader refuses ${replacement} replacement between stat and open`, async () => {
    const path = await fixture()
    await updateNativeRuntime(path, storageId, () => ({
      version: 1,
      storageId,
      accounts: {},
    }))
    const replacementPath = join(dirname(path), 'replacement.json')
    await writeFile(
      replacementPath,
      JSON.stringify({ version: 1, storageId, accounts: {} }),
      { mode: replacement === 'permissions' ? 0o644 : 0o600 },
    )
    const realOpen = fsPromises.open
    let armed = true
    let replacements = 0
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(
      async (openedPath, flags, mode) => {
        if (armed && openedPath === path) {
          armed = false
          if (replacement === 'permissions')
            await fsPromises.rename(replacementPath, path)
          else {
            await rm(path)
            await symlink(replacementPath, path)
          }
          replacements++
        }
        return realOpen(openedPath, flags, mode)
      },
    )
    try {
      await expect(readNativeRuntime(path, storageId)).rejects.toMatchObject({
        code: replacement === 'permissions' ? 'unsafe-runtime' : 'runtime-io',
      })
      expect(replacements).toBe(1)
    } finally {
      openSpy.mockRestore()
    }
  })
}

test('runtime reader refuses a foreign owner on the opened handle', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => ({
    version: 1,
    storageId,
    accounts: {},
  }))
  const realOpen = fsPromises.open
  let changedOwner = false
  const openSpy = spyOn(fsPromises, 'open').mockImplementation(
    async (openedPath, flags, mode) => {
      const file = await realOpen(openedPath, flags, mode)
      if (openedPath === path) {
        const realStat = file.stat.bind(file)
        Object.defineProperty(file, 'stat', {
          value: async () => {
            const opened = await realStat()
            Object.defineProperty(opened, 'uid', { value: opened.uid + 1 })
            changedOwner = true
            return opened
          },
        })
      }
      return file
    },
  )
  try {
    await expect(readNativeRuntime(path, storageId)).rejects.toMatchObject({
      code: 'unsafe-runtime',
    })
    expect(changedOwner).toBe(true)
  } finally {
    openSpy.mockRestore()
  }
})

async function runtimeReaderWithoutNoFollow(
  path: string,
): Promise<typeof readNativeRuntime> {
  const sourceUrl = new URL('../native-runtime.ts', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const flag = 'const noFollow = constants.O_NOFOLLOW ?? 0'
  expect(source.split(flag)).toHaveLength(2)
  // Simulate a platform without the flag in an isolated copy of the actual
  // reader. All file checks and retry logic stay identical to production.
  const isolated = source
    .replace(flag, 'const noFollow = 0')
    .replace(/from '([^']+)'/g, (_match, specifier: string) => {
      const resolved = specifier.startsWith('.')
        ? new URL(specifier, sourceUrl).href
        : specifier.startsWith('node:')
          ? specifier
          : import.meta.resolve(specifier)
      return `from '${resolved}'`
    })
  const modulePath = join(dirname(path), 'reader-without-no-follow.ts')
  await writeFile(modulePath, isolated, { mode: 0o600 })
  const module: typeof import('../native-runtime.ts') = await import(modulePath)
  return module.readNativeRuntime
}

for (const replacements of [1, 2]) {
  test(`runtime reader without no-follow bounds atomic replacement recovery at ${replacements} replacements`, async () => {
    const path = await fixture()
    await updateNativeRuntime(path, storageId, () => ({
      version: 1,
      storageId,
      accounts: {
        row: {
          binding: {
            kind: 'local',
            storageId,
            rowId: 'row',
            credentialEpoch: 1,
          },
          lastUsed: 0,
        },
      },
    }))
    const reader = await runtimeReaderWithoutNoFollow(path)
    const realOpen = fsPromises.open
    let publishing = false
    let changed = 0
    let openedByReader = 0
    let closedByReader = 0
    const openSpy = spyOn(fsPromises, 'open').mockImplementation(
      async (openedPath, flags, mode) => {
        const outerRead = openedPath === path && !publishing
        if (outerRead && changed < replacements) {
          publishing = true
          try {
            await updateNativeRuntime(path, storageId, (state) => {
              const row = state.accounts.row
              if (!row) throw new Error('Expected seeded runtime row')
              row.lastUsed = ++changed
              return state
            })
          } finally {
            publishing = false
          }
        }
        const file = await realOpen(openedPath, flags, mode)
        if (outerRead) {
          openedByReader++
          const realClose = file.close.bind(file)
          file.close = async () => {
            closedByReader++
            return realClose()
          }
        }
        return file
      },
    )
    try {
      if (replacements === 1)
        await expect(reader(path, storageId)).resolves.toMatchObject({
          status: 'ready',
          state: { accounts: { row: { lastUsed: 1 } } },
        })
      else
        await expect(reader(path, storageId)).rejects.toMatchObject({
          code: 'unsafe-runtime',
        })
      expect(changed).toBe(replacements)
      expect(openedByReader).toBe(2)
      expect(closedByReader).toBe(2)
    } finally {
      openSpy.mockRestore()
    }
  })
}

async function joinRuntimeUpdates(updates: Promise<NativeRuntimeState>[]) {
  try {
    return await Promise.all(updates)
  } finally {
    // Promise.all rejects before unfinished siblings settle. Keep the body alive
    // until they finish using its fixture, without replacing the original error.
    await Promise.allSettled(updates)
  }
}

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
        tokenHash: hashRefreshToken('synthetic-refresh'),
        refreshTokenFingerprint: tokenFingerprint('synthetic-refresh'),
        status: 503,
        permanent: false,
      },
      refreshErrorClearedAt: 100,
      refreshLeaseId: 'lease-id',
      refreshLeaseUntil: 777,
      refreshLeaseTokenHash: hashRefreshToken('synthetic-refresh'),
      lastQuotaRefreshError: {
        message: 'synthetic quota failure',
        checkedAt: 555,
        nextRetryAt: 888,
        retryCount: 1,
        accountIdentity: 'synthetic-account-A',
        tokenHash: hashRefreshToken('synthetic-refresh'),
        refreshTokenFingerprint: tokenFingerprint('synthetic-refresh'),
        status: 429,
        permanent: false,
      },
      quotaErrorGeneration: 3,
      quotaErrorClearedAt: 444,
      quotaCheckedAt: 234,
      quotaToken: tokenFingerprint('synthetic-access'),
      profile: {
        tier: 'max',
        orgType: 'individual',
        checkedAt: 123,
        accountIdentity: 'synthetic-account-A',
        providerAccountUuid: 'synthetic-account-A',
        tokenFingerprint: tokenFingerprint('synthetic-access'),
      },
      prime: { count: 5, inputTokens: 12345, outputTokens: 678, since: 90 },
      authLineageId: 'prime-lineage',
      primeAuthLineageRefreshTokenFingerprint:
        tokenFingerprint('synthetic-refresh'),
    },
    'vault-route': {
      binding: {
        kind: 'custody',
        storageId,
        routeId: 'vault-route',
        credentialId: 'credential-A',
        accountIdentity: vaultAccountIdentity,
        recordVersion: 7,
      },
      quota: toNativeQuotaMap({
        accountIdentity: vaultAccountIdentity,
        checkedAt: 999,
        scoped: [],
        source: 'headers',
        fieldSources: { scoped: 'poll' },
      }),
      profile: {
        tier: 'max',
        orgType: 'team',
        checkedAt: 998,
        accountIdentity: vaultAccountIdentity,
      },
      quotaToken: vaultAccountIdentity,
    },
  },
}

function state(): NativeRuntimeState {
  return decodeNativeRuntime(structuredClone(full), storageId)
}

test('native local refresh lineage round-trips explicitly without inferring legacy aliases', async () => {
  const parent = join(
    import.meta.dir,
    '../../../../node_modules/.cache/native-local-runtime-readers',
  )
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'refresh-errors-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'runtime.json')
  const local = full.accounts['local-row']
  const credentialFingerprint = fingerprintOf({
    type: 'oauth',
    refresh: 'synthetic-refresh',
  })
  expect(credentialFingerprint).not.toBe(local.lastRefreshError.tokenHash)
  const native = {
    ...full,
    accounts: {
      'local-row': {
        ...local,
        lastRefreshError: { ...local.lastRefreshError, credentialFingerprint },
        refreshErrorClearedAt: 0,
        quotaErrorClearedAt: 0,
        quotaErrorGeneration: 0,
      },
    },
  }
  const before = structuredClone(native)
  expect<unknown>(
    await updateNativeRuntime(path, storageId, () =>
      decodeNativeRuntime(native, storageId),
    ),
  ).toEqual(native)
  expect<unknown>(await readNativeRuntime(path, storageId)).toEqual({
    status: 'ready',
    state: native,
  })
  expect(native).toEqual(before)
  const old = decodeNativeRuntime(full, storageId).accounts['local-row']!
    .lastRefreshError!
  expect(Object.hasOwn(old, 'credentialFingerprint')).toBe(false)
  expect(old.tokenHash).toBe(hashRefreshToken('synthetic-refresh'))
  expect(old.refreshTokenFingerprint).toBe(
    tokenFingerprint('synthetic-refresh'),
  )
})

test('native local refresh lineage rejects malformed fingerprints without widening quota or custody', () => {
  const local = full.accounts['local-row']
  for (const credentialFingerprint of [
    undefined,
    null,
    0,
    [],
    {},
    '',
    'a'.repeat(16),
    'A'.repeat(64),
    ` ${'a'.repeat(64)}`,
    'sk-ant-oat01-synthetic-secret',
  ]) {
    expect(() =>
      decodeNativeRuntime(
        {
          ...full,
          accounts: {
            'local-row': {
              ...local,
              lastRefreshError: {
                ...local.lastRefreshError,
                credentialFingerprint,
              },
            },
          },
        },
        storageId,
      ),
    ).toThrow('Anthropic runtime state is invalid')
  }
  const credentialFingerprint = fingerprintOf({
    type: 'oauth',
    refresh: 'synthetic-refresh',
  })
  expect(() =>
    decodeNativeRuntime(
      {
        ...full,
        accounts: {
          'local-row': {
            ...local,
            lastQuotaRefreshError: {
              ...local.lastQuotaRefreshError,
              credentialFingerprint,
            },
          },
        },
      },
      storageId,
    ),
  ).toThrow('Anthropic runtime state is invalid')
  expect(() =>
    decodeNativeRuntime(
      {
        ...full,
        accounts: {
          'vault-route': {
            ...full.accounts['vault-route'],
            lastRefreshError: {
              message: 'synthetic error',
              checkedAt: 1,
              credentialFingerprint,
            },
          },
        },
      },
      storageId,
    ),
  ).toThrow('Anthropic runtime state is invalid')
  for (const checkedAt of [0, 100]) {
    expect(() =>
      decodeNativeRuntime(
        {
          ...full,
          accounts: {
            'local-row': {
              ...local,
              refreshErrorClearedAt: checkedAt,
              lastRefreshError: {
                ...local.lastRefreshError,
                credentialFingerprint,
                checkedAt,
              },
            },
          },
        },
        storageId,
      ),
    ).toThrow('Anthropic runtime state is invalid')
  }
})

test('native local refresh lineage retains monotonic error reset floors', async () => {
  const parent = join(
    import.meta.dir,
    '../../../../node_modules/.cache/native-local-runtime-readers',
  )
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'refresh-floors-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'runtime.json')
  const initial = state()
  initial.accounts['local-row']!.lastRefreshError!.credentialFingerprint =
    fingerprintOf({ type: 'oauth', refresh: 'synthetic-refresh' })
  await updateNativeRuntime(path, storageId, () => initial)
  const before = await readFile(path, 'utf8')
  for (const change of [
    'older',
    'remove-without-clear',
    'remove-before-clear',
  ] as const) {
    await expect(
      updateNativeRuntime(path, storageId, (current) => {
        const local = current.accounts['local-row']!
        if (change === 'older') local.lastRefreshError!.checkedAt--
        else {
          delete local.lastRefreshError
          if (change === 'remove-before-clear')
            local.refreshErrorClearedAt = 332
        }
        return current
      }),
    ).rejects.toMatchObject({ code: 'runtime-conflict' })
    expect(await readFile(path, 'utf8')).toBe(before)
  }
  const cleared = await updateNativeRuntime(path, storageId, (current) => {
    delete current.accounts['local-row']!.lastRefreshError
    current.accounts['local-row']!.refreshErrorClearedAt = 333
    return current
  })
  expect(cleared.accounts['local-row']!.refreshErrorClearedAt).toBe(333)
  expect(cleared.accounts['local-row']!.lastRefreshError).toBeUndefined()
})

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
      'prime',
      'authLineageId',
      'primeAuthLineageRefreshTokenFingerprint',
    ].sort(),
  )
  expect(Object.keys(full.accounts['vault-route']).sort()).toEqual([
    'binding',
    'profile',
    'quota',
    'quotaToken',
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

test('runtime credential metadata control rejects bearer and unexplained identifier forms without publication', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = await readFile(path, 'utf8')
  const local = full.accounts['local-row']
  const bearer = `sk-ant-oat01-${'b'.repeat(80)}`
  const malformed: unknown[] = []
  for (const field of [
    'quotaToken',
    'refreshLeaseTokenHash',
    'primeAuthLineageRefreshTokenFingerprint',
    'profileToken',
  ]) {
    for (const token of [bearer, 'unexplained-token-label']) {
      malformed.push({
        ...full,
        accounts: { 'local-row': { ...local, [field]: token } },
      })
    }
  }
  for (const errorField of ['lastRefreshError', 'lastQuotaRefreshError']) {
    for (const tokenField of ['tokenHash', 'refreshTokenFingerprint']) {
      malformed.push({
        ...full,
        accounts: {
          'local-row': {
            ...local,
            [errorField]: { ...local.lastRefreshError, [tokenField]: bearer },
          },
        },
      })
    }
  }
  malformed.push({
    ...full,
    accounts: {
      'local-row': {
        ...local,
        profile: { ...local.profile, tokenFingerprint: bearer },
      },
    },
  })
  for (const candidate of malformed) {
    expect(() => decodeNativeRuntime(candidate, storageId)).toThrow(
      'Anthropic runtime state is invalid',
    )
    await expect(
      updateNativeRuntime(path, storageId, () =>
        decodeNativeRuntime(candidate, storageId),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-runtime',
      message: 'Anthropic runtime state is invalid',
    })
    expect(await readFile(path, 'utf8')).toBe(before)
  }
})

test('runtime metadata preserves only the fingerprint width each established writer supplies', () => {
  const local = full.accounts['local-row']
  const short = tokenFingerprint('synthetic-access')
  const long = hashRefreshToken('synthetic-refresh')
  expect(short).toMatch(/^[a-f0-9]{16}$/)
  expect(long).toMatch(/^[a-f0-9]{64}$/)
  expect<unknown>(decodeNativeRuntime(full, storageId)).toEqual(full)
  const wrongWidths: unknown[] = [
    { ...local, quotaToken: long },
    { ...local, refreshLeaseTokenHash: short },
    { ...local, primeAuthLineageRefreshTokenFingerprint: long },
    {
      ...local,
      lastRefreshError: { ...local.lastRefreshError, tokenHash: short },
    },
    {
      ...local,
      lastRefreshError: {
        ...local.lastRefreshError,
        refreshTokenFingerprint: long,
      },
    },
    {
      ...local,
      lastQuotaRefreshError: {
        ...local.lastQuotaRefreshError,
        tokenHash: short,
      },
    },
    {
      ...local,
      lastQuotaRefreshError: {
        ...local.lastQuotaRefreshError,
        refreshTokenFingerprint: long,
      },
    },
    { ...local, profile: { ...local.profile, tokenFingerprint: long } },
  ]
  for (const candidate of wrongWidths)
    expect(() =>
      decodeNativeRuntime(
        { ...full, accounts: { 'local-row': candidate } },
        storageId,
      ),
    ).toThrow()
})

test('runtime vault quota identifiers must be UUIDs equal to the observed account', () => {
  const custody = full.accounts['vault-route']
  expect<unknown>(decodeNativeRuntime(full, storageId)).toEqual(full)
  for (const token of [
    tokenFingerprint('synthetic-access'),
    'unexplained-account',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ]) {
    expect(() =>
      decodeNativeRuntime(
        {
          ...full,
          accounts: { 'vault-route': { ...custody, quotaToken: token } },
        },
        storageId,
      ),
    ).toThrow()
  }
  const unexplained = {
    ...custody,
    binding: { ...custody.binding, accountIdentity: 'unexplained-account' },
    quota: toNativeQuotaMap({ accountIdentity: 'unexplained-account' }),
    profile: { ...custody.profile, accountIdentity: 'unexplained-account' },
    quotaToken: 'unexplained-account',
  }
  expect(() =>
    decodeNativeRuntime(
      { ...full, accounts: { 'vault-route': unexplained } },
      storageId,
    ),
  ).toThrow()
})

test('runtime refuses profileToken even when it resembles a known fingerprint', () => {
  const local = full.accounts['local-row']
  for (const token of [
    tokenFingerprint('synthetic-access'),
    hashRefreshToken('synthetic-refresh'),
    vaultAccountIdentity,
    'unexplained-profile-token',
  ]) {
    expect(() =>
      decodeNativeRuntime(
        {
          ...full,
          accounts: { 'local-row': { ...local, profileToken: token } },
        },
        storageId,
      ),
    ).toThrow()
  }
})

test('runtime stage ownership control preserves an existing collision sentinel', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = await readFile(path, 'utf8')
  const uuid = '11111111-1111-4111-8111-111111111111'
  const stage = `${path}.native-runtime.${uuid}.partial`
  await writeFile(stage, 'another-writer-stage', { mode: 0o600 })
  const module = new URL('../native-runtime.ts', import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { mock } from 'bun:test';
    import * as crypto from 'node:crypto';
    let uuidCalls = 0;
    let httpAttempts = 0;
    globalThis.fetch = async () => { httpAttempts++; throw new Error('HTTP forbidden'); };
    mock.module('node:crypto', () => ({ ...crypto, randomUUID: () => { uuidCalls++; return ${JSON.stringify(uuid)}; } }));
    const { updateNativeRuntime } = await import(${JSON.stringify(module)});
    let outcome = 'accepted';
    try { await updateNativeRuntime(${JSON.stringify(path)}, ${JSON.stringify(storageId)}, current => current); }
    catch (error) { outcome = error.code; }
    console.log(JSON.stringify({ outcome, uuidCalls, httpAttempts }));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe('')
  const result: unknown = JSON.parse(await new Response(child.stdout).text())
  expect(result).toMatchObject({ outcome: 'runtime-io', httpAttempts: 0 })
  if (
    !result ||
    typeof result !== 'object' ||
    !('uuidCalls' in result) ||
    typeof result.uuidCalls !== 'number'
  )
    throw new Error('UUID substitution evidence missing')
  expect(result.uuidCalls).toBeGreaterThan(0)
  expect(await readFile(stage, 'utf8')).toBe('another-writer-stage')
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('runtime relinquishes the stage name after rename instead of deleting a successor file', async () => {
  const path = await fixture()
  let stage: string | undefined
  await expect(
    updateNativeRuntime(path, storageId, () => state(), {
      beforeRename: async () => {
        const names = (await readdir(dirname(path))).filter((name) =>
          isNativeRuntimeStagingName(path, name),
        )
        expect(names.length).toBe(1)
        const name = names[0]
        if (!name) throw new Error('fixture stage missing')
        stage = join(dirname(path), name)
      },
      afterRename: async () => {
        if (!stage) throw new Error('fixture stage missing')
        await writeFile(stage, 'successor-stage', { mode: 0o600, flag: 'wx' })
        throw new Error('synthetic after-rename failure')
      },
    }),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  if (!stage) throw new Error('fixture stage missing')
  expect(await readFile(stage, 'utf8')).toBe('successor-stage')
  expect<unknown>(await readNativeRuntime(path, storageId)).toEqual({
    status: 'ready',
    state: full,
  })
})

test('runtime effective-owner control refuses foreign euid before and after opening', async () => {
  const path = await fixture()
  await updateNativeRuntime(path, storageId, () => state())
  const before = await readFile(path, 'utf8')
  const uid = (await stat(path)).uid
  const module = new URL('../native-runtime.ts', import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    const { readNativeRuntime } = await import(${JSON.stringify(module)});
    let httpAttempts = 0;
    globalThis.fetch = async () => { httpAttempts++; throw new Error('HTTP forbidden'); };
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => ${uid} });
    async function run(opened) {
      let euidCalls = 0;
      Object.defineProperty(process, 'geteuid', { configurable: true, value: () => { euidCalls++; return ${uid} + (opened && euidCalls === 1 ? 0 : 1); } });
      let outcome = 'accepted';
      try { await readNativeRuntime(${JSON.stringify(path)}, ${JSON.stringify(storageId)}); }
      catch (error) { outcome = error.code; }
      return { outcome, euidCalls };
    }
    console.log(JSON.stringify({ initial: await run(false), opened: await run(true), httpAttempts }));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe('')
  const result: unknown = JSON.parse(await new Response(child.stdout).text())
  expect(result).toEqual({
    initial: { outcome: 'unsafe-runtime', euidCalls: 1 },
    opened: { outcome: 'unsafe-runtime', euidCalls: 2 },
    httpAttempts: 0,
  })
  expect(await readFile(path, 'utf8')).toBe(before)
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
  const updates = Array.from({ length: 12 }, () =>
    updateNativeRuntime(path, storageId, (current) => {
      const local = current.accounts['local-row']
      if (!local?.prime) throw new Error('fixture prime missing')
      local.prime.count += 1
      return current
    }),
  )
  await joinRuntimeUpdates(updates)
  const read = await readNativeRuntime(path, storageId)
  expect(read.status).toBe('ready')
  if (read.status !== 'ready') throw new Error('runtime missing')
  expect(read.state.accounts['local-row']?.prime?.count).toBe(17)
})

test('runtime sibling join keeps an active fixture until settlement and preserves the first failure', async () => {
  const path = await fixture()
  const root = dirname(dirname(path))
  // Use separate locks so one runtime update can fail while the other waits
  // inside the fixture directory that cleanup will remove.
  const failedPath = join(dirname(path), 'refused-state.json')
  await updateNativeRuntime(path, storageId, () => state())
  await updateNativeRuntime(failedPath, storageId, () => state())
  const before = await readFile(path, 'utf8')
  const lifetime = new TestLifetime()
  const resumeSibling = lifetime.gate()
  const entered = Promise.withResolvers<void>()
  const firstFailure = Promise.withResolvers<unknown>()
  const removed = Promise.withResolvers<void>()
  let siblingSettled = false
  let cleanupStarted = false
  let cleanupAfterSibling = false
  let stageRead = 'pending'
  let siblingRead = 'pending'
  lifetime.deferCleanup(async () => {
    cleanupStarted = true
    cleanupAfterSibling = siblingSettled
    try {
      await rm(root, { recursive: true, force: true })
    } finally {
      removed.resolve()
    }
  })
  const sibling = updateNativeRuntime(
    path,
    storageId,
    (current) => ({ ...current, relay: { token: 'synthetic-sibling-relay' } }),
    {
      beforeRename: async () => {
        const names = (await readdir(dirname(path))).filter((name) =>
          isNativeRuntimeStagingName(path, name),
        )
        const name = names[0]
        if (names.length !== 1 || !name)
          throw new Error('fixture sibling stage missing')
        const stage = join(dirname(path), name)
        entered.resolve()
        await resumeSibling.wait
        // After teardown releases the sibling, yield through real file reads. If
        // the test body has settled, fixture cleanup can start before these finish.
        try {
          await readFile(stage)
          stageRead = 'present'
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            throw error
          stageRead = 'ENOENT'
        }
        // If cleanup started before this update settled, wait for fixture deletion
        // to finish so the following read observes the completed removal.
        if (cleanupStarted) await removed.promise
        try {
          siblingRead = await readFile(path, 'utf8')
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
          )
            throw error
          siblingRead = 'ENOENT'
        }
      },
    },
  ).finally(() => {
    siblingSettled = true
    // Unblock the failing update if this sibling stops before reaching its hook.
    entered.resolve()
  })
  const first = updateNativeRuntime(
    failedPath,
    storageId,
    (current) => current,
    {
      beforeRename: async () => {
        await entered.promise
        throw new Error('synthetic publication refusal')
      },
    },
  ).catch((error: unknown) => {
    firstFailure.resolve(error)
    throw error
  })
  const updates = [first, sibling]
  const body = lifetime.runBody(() => joinRuntimeUpdates(updates))
  const observedBody = body.catch((error: unknown) => error)
  const originalError = await firstFailure.promise
  await lifetime.finish()
  const bodyError = await observedBody
  const results = await Promise.allSettled(updates)
  expect(originalError).toMatchObject({
    code: 'publication-refused',
    message: 'Anthropic runtime publication was refused',
  })
  expect(bodyError).toBe(originalError)
  expect(results[0]).toMatchObject({
    status: 'rejected',
    reason: originalError,
  })
  expect(cleanupAfterSibling).toBe(true)
  expect(stageRead).toBe('present')
  expect(siblingRead).toBe(before)
  expect(results[1]).toMatchObject({
    status: 'fulfilled',
    value: { relay: { token: 'synthetic-sibling-relay' } },
  })
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
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
            accountIdentity: vaultAccountIdentity,
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
