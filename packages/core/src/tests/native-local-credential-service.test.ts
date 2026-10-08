import { expect } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fingerprintOf, type PoolRow } from '@cortexkit/common-auth/store'

import {
  ClaudeOAuthRefreshError,
  type refreshClaudeOAuthToken,
} from '../auth.ts'
import type { ProviderAccountUuid } from '../claude-code.ts'
import type { NativeLocalCredentialValidation } from '../native-credential-validation.ts'
import type {
  NativeLocalCredentialServiceOptions,
  NativeLocalFailurePolicyInput,
} from '../native-local-credential-service.ts'
import * as production from '../native-local-credential-service.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import type {
  NativeRefreshRequest,
  NativeRefreshResult,
} from '../native-refresh-coordinator.ts'
import {
  isNativeRuntimeStagingName,
  type NativeLocalFailurePolicy,
  type NativeRuntimeEntry,
  readNativeRuntime,
  updateNativeRuntime,
} from '../native-runtime.ts'
import {
  captureNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
} from '../pool-binding.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { tokenFingerprint } from '../token-fingerprint.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate } = createTestLifetimeSuite()
const accountA = '11111111-2222-4333-8444-555555555555' as ProviderAccountUuid
const original = {
  type: 'oauth' as const,
  access: 'synthetic-service-access',
  refresh: 'synthetic-service-refresh',
  expires: 4_000_000_000_000,
}
const successor = {
  access: 'synthetic-service-successor-access',
  refresh: 'synthetic-service-successor-refresh',
  expires: 4_000_000_100_000,
  expiresIn: 3_600,
}
const providerBody = 'synthetic-provider-body'
const start = 1_000_000

type ServiceModule = typeof production
type Exchange = Awaited<ReturnType<typeof refreshClaudeOAuthToken>>
type Authority = 'committed' | 'missing' | 'incomplete' | 'invalid'

interface FixtureOptions {
  /** Whether the pool row records the account UUID. */
  poolIdentity?: boolean
  /** Before network work: 'known' stores the account UUID, 'unknown' omits it, and 'missing' has no entry. */
  runtime?: 'known' | 'unknown' | 'missing'
  metadata?:
    | Partial<NativeRuntimeEntry>
    | ((binding: NativeLocalPoolBinding) => Partial<NativeRuntimeEntry>)
  authority?: Authority
  expires?: number
}

function migrationInput(paths: NativePoolPaths) {
  const root = dirname(paths.config)
  return {
    host: 'opencode' as const,
    sources: {
      config: 'a'.repeat(64),
      state: 'b'.repeat(64),
      hostAuth: 'absent',
      routing: null,
    },
    routingPaths: {
      source: join(root, 'legacy-routing.json'),
      destination: join(root, 'native-routing.json'),
    },
    hostAuthPath: join(root, 'host-auth.json'),
  }
}

/**
 * Write a migration journal directly in the requested phase. Each request
 * still reads it through the production authority guard, which decodes and
 * checks it; pool-authority.test.ts covers the journal API's phase changes.
 */
async function writeJournal(paths: NativePoolPaths, authority: Authority) {
  if (authority === 'missing') return
  const committed = authority === 'committed'
  await writeFile(
    paths.journal,
    authority === 'invalid'
      ? '{"version":2'
      : JSON.stringify({
          version: 3,
          storageId: paths.storageId,
          ...migrationInput(paths),
          phase: committed ? 'committed' : 'building',
          expectedHostAuth: committed ? 'absent' : 'unprepared',
          expectedRouting: committed ? null : 'unprepared',
          preparedProof: committed
            ? { version: 1, rows: [], runtimeDigest: 'f'.repeat(64) }
            : null,
        }),
    { mode: 0o600 },
  )
}

async function fixture(options: FixtureOptions = {}) {
  const parent = new URL(
    '../../../../node_modules/.cache/native-local-credential-service/',
    import.meta.url,
  )
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent.pathname, 'fixture-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
  const clock = { time: start }
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now: () => clock.time,
  })
  async function row(): Promise<PoolRow> {
    const read = await store.read()
    const found = read.status === 'ready' ? read.rows[0] : undefined
    if (!found) throw new Error('Missing fixture row')
    return found
  }
  /** Build the expected account-check record from stored credentials, not from service output. */
  async function proof(): Promise<NativeLocalCredentialValidation> {
    const current = await row()
    const c = current.credential
    if (c?.type !== 'oauth' || !c.access || c.expires === undefined)
      throw new Error('Fixture row has no OAuth access')
    return {
      binding: {
        ...captureNativeLocalPoolBinding(paths, current),
        identity: accountA,
      },
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
  async function entry(): Promise<NativeRuntimeEntry | undefined> {
    const read = await readNativeRuntime(paths.runtime, paths.storageId)
    return read.status === 'ready' ? read.state.accounts.row : undefined
  }
  await store.initialize()
  await store.add({
    id: 'row',
    ...(options.poolIdentity !== false ? { identity: accountA } : {}),
    credential: { ...original, expires: options.expires ?? original.expires },
  })
  const binding = captureNativeLocalPoolBinding(paths, await row())
  const runtime = options.runtime ?? 'known'
  if (runtime !== 'missing') {
    const { identity: _identity, ...unknown } = binding
    const metadata =
      typeof options.metadata === 'function'
        ? options.metadata(binding)
        : options.metadata
    await updateNativeRuntime(paths.runtime, paths.storageId, () => ({
      version: 1,
      storageId: paths.storageId,
      accounts: {
        row: {
          binding:
            runtime === 'known' ? { ...binding, identity: accountA } : unknown,
          ...metadata,
        },
      },
    }))
  }
  await writeJournal(paths, options.authority ?? 'committed')
  const f = {
    root,
    paths,
    store,
    binding,
    row,
    proof,
    entry,
    get time(): number {
      return clock.time
    },
    set time(value: number) {
      clock.time = value
    },
    exchanges: 0,
    lookups: 0,
    failures: [] as NativeLocalFailurePolicyInput[],
    exchange: async (): Promise<Exchange> => successor,
    lookup: async (): Promise<ProviderAccountUuid | undefined> => accountA,
    policy: (
      _input: NativeLocalFailurePolicyInput,
    ): NativeLocalFailurePolicy => ({
      checkedAt: clock.time,
      nextRetryAt: clock.time,
    }),
    request(fields: Partial<NativeRefreshRequest> = {}): NativeRefreshRequest {
      return { mode: 'local', intent: 'serve', binding, ...fields }
    },
  }
  return f
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function service(
  f: Fixture,
  module: ServiceModule = production,
  overrides: Partial<NativeLocalCredentialServiceOptions> = {},
) {
  return module.createNativeLocalCredentialService({
    paths: f.paths,
    now: () => f.time,
    externalPolicy: () => ({ status: 'allowed' }),
    failurePolicy: (input) => {
      f.failures.push(input)
      return f.policy(input)
    },
    refreshToken: async (input) => {
      expect(input.maxRetries).toBe(0)
      f.exchanges++
      return f.exchange()
    },
    resolveIdentity: async () => {
      f.lookups++
      return {
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: await f.lookup(),
      }
    },
    ...overrides,
  })
}

async function snapshot(root: string) {
  const result: Record<string, string> = {}
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    try {
      result[name] = (await readFile(join(root, name))).toString('hex')
    } catch {
      result[name] = 'directory'
    }
  }
  return result
}

async function stages(f: Fixture) {
  return (await readdir(f.root)).filter((name) =>
    isNativeRuntimeStagingName(f.paths.runtime, name),
  )
}

function leaksNoSecret(value: unknown) {
  const text = JSON.stringify(value)
  for (const secret of [
    original.access,
    original.refresh,
    successor.refresh,
    providerBody,
  ])
    expect(text).not.toContain(secret)
}

/** Report which safety property failed, so a broken module copy is identified by name. */
async function named(name: string, check: () => unknown) {
  try {
    await check()
  } catch (error) {
    throw new Error(
      `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// Copy the service into a temporary directory and keep its other imports
// pointed at production files. A test can remove one named check from that
// copy without replacing the real locks, file writes or coordinator.
async function owned(rewrite?: { from: string; to: string }) {
  const parent = new URL(
    '../../../../node_modules/.cache/native-local-credential-service/',
    import.meta.url,
  )
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent.pathname, 'owned-'))
  deferCleanup(() => rm(directory, { recursive: true, force: true }))
  const sourcePath = new URL(
    '../native-local-credential-service.ts',
    import.meta.url,
  )
  let source = await readFile(sourcePath, 'utf8')
  if (rewrite) {
    expect(source.split(rewrite.from)).toHaveLength(2)
    source = source.replace(rewrite.from, rewrite.to)
  }
  source = source.replace(
    /from '(\.\/[^']+)'/g,
    (_match, relative: string) =>
      `from '${new URL(relative, sourcePath).href}'`,
  )
  const path = join(directory, 'service.ts')
  await writeFile(path, source)
  const module: ServiceModule = await import(pathToFileURL(path).href)
  return module
}

const authorityCodes = {
  missing: 'migration-required',
  incomplete: 'migration-incomplete',
  invalid: 'invalid-journal',
} as const

for (const authority of ['missing', 'incomplete', 'invalid'] as const) {
  test(`authority ${authority} journal refuses every request before provider dispatch or writes`, async () => {
    const f = await fixture({ authority, expires: start - 1 })
    const s = service(f)
    const before = await snapshot(f.root)
    for (const fields of [
      {},
      { intent: 'refresh' as const },
      { rejectedAccessToken: original.access },
    ])
      expect(await s.authorize(f.request(fields))).toEqual({
        status: 'refused',
        reason: authorityCodes[authority],
        persisted: false,
      })
    expect([f.exchanges, f.lookups, f.failures.length]).toEqual([0, 0, 0])
    expect(await snapshot(f.root)).toEqual(before)
  })
}

async function authorityScenario(module: ServiceModule) {
  const f = await fixture({ authority: 'missing' })
  const result = await service(f, module).authorize(f.request())
  await named('authority refusal precedes provider dispatch', () => {
    expect(result).toEqual({
      status: 'refused',
      reason: 'migration-required',
      persisted: false,
    })
    expect([f.exchanges, f.lookups]).toEqual([0, 0])
  })
  // Committing migration lets this request use the validated credential.
  await writeJournal(f.paths, 'committed')
  const served = await service(f, module).authorize(f.request())
  await named('committed authority serves validated access', async () => {
    expect(served).toMatchObject({ status: 'usable', source: 'validated' })
    expect([f.exchanges, f.lookups]).toEqual([0, 1])
  })
}

test('exact positive proof is published before current access is served', async () => {
  const f = await fixture()
  const s = service(f)
  expect(await f.entry()).toEqual({
    binding: { ...f.binding, identity: accountA },
  })
  const result = await s.authorize(f.request())
  const proof = await f.proof()
  expect(result).toEqual({
    status: 'usable',
    source: 'validated',
    binding: proof.binding,
    access: original.access,
    expires: original.expires,
    subject: proof,
    validation: proof,
  })
  expect(await f.entry()).toEqual({
    binding: proof.binding,
    credentialValidation: proof,
  })
  expect([f.exchanges, f.lookups, f.failures.length]).toEqual([0, 1, 0])
  // The stored account check can serve unchanged credentials without a new lookup.
  expect(await s.authorize(f.request())).toMatchObject({
    status: 'usable',
    source: 'current',
    access: original.access,
    validation: proof,
  })
  expect([f.exchanges, f.lookups]).toEqual([0, 1])
  expect(await stages(f)).toEqual([])
})

const knownMetadata = (
  binding: NativeLocalPoolBinding,
): Partial<NativeRuntimeEntry> => ({
  lastUsed: 1,
  lastRefreshedAt: 2,
  refreshErrorClearedAt: 3,
  lastRefreshError: {
    message: 'older refresh failure',
    checkedAt: 11,
    accountIdentity: accountA,
    credentialFingerprint: fingerprintOf({
      type: 'oauth',
      refresh: 'synthetic-retired-refresh',
    }),
  },
  quotaErrorClearedAt: 4,
  quotaErrorGeneration: 7,
  profile: {
    tier: 'max',
    orgType: 'team',
    checkedAt: 5,
    providerAccountUuid: accountA,
  },
  prime: { count: 1, inputTokens: 2, outputTokens: 3, since: 4 },
  authLineageId: 'synthetic-lineage',
  validationRetry: {
    subject: {
      binding: { ...binding, identity: accountA },
      credentialFingerprint: fingerprintOf({
        type: 'oauth',
        refresh: 'synthetic-retired-refresh',
      }),
      version: { accessFingerprint: tokenFingerprint('retired'), expires: 9 },
    },
    checkedAt: 20,
    nextRetryAt: 40,
  },
})

async function knownRotationScenario(module: ServiceModule) {
  const f = await fixture({ metadata: knownMetadata })
  const before = await f.entry()
  if (!before?.profile || !before.validationRetry)
    throw new Error('Missing fixture metadata')
  const result = await service(f, module).authorize(
    f.request({ rejectedAccessToken: original.access }),
  )
  await named(
    'known rotation preserves metadata and records proof',
    async () => {
      const proof = await f.proof()
      expect(proof.credentialFingerprint).toBe(
        fingerprintOf({ type: 'oauth', refresh: successor.refresh }),
      )
      expect(result).toMatchObject({
        status: 'usable',
        source: 'rotated',
        access: successor.access,
        validation: proof,
      })
      expect(await f.entry()).toEqual({
        ...before,
        credentialValidation: proof,
      })
      expect([f.exchanges, f.lookups, f.failures.length]).toEqual([1, 1, 0])
    },
  )
}

test('known-token rotation preserves every runtime metadata field and records successor proof', async () => {
  await knownRotationScenario(production)
})

async function firstIdentityScenario(module: ServiceModule) {
  const f = await fixture({
    runtime: 'unknown',
    metadata: {
      lastUsed: 1,
      refreshErrorClearedAt: 3,
      lastRefreshError: { message: 'unproven failure', checkedAt: 11 },
      quotaErrorClearedAt: 4,
      quotaErrorGeneration: 7,
      profile: { tier: 'max', orgType: 'team', checkedAt: 5 },
      authLineageId: 'synthetic-unproven-lineage',
    },
  })
  const result = await service(f, module).authorize(f.request())
  await named('first-identity repair serves validated access', async () => {
    const proof = await f.proof()
    expect(result).toMatchObject({
      status: 'usable',
      source: 'validated',
      access: original.access,
      validation: proof,
    })
    // Unproven profile, usage and error details are dropped. The reset fence
    // advances to the dropped error's time so that error cannot be restored.
    expect(await f.entry()).toEqual({
      binding: proof.binding,
      credentialValidation: proof,
      refreshErrorClearedAt: 11,
      quotaErrorClearedAt: 4,
      quotaErrorGeneration: 7,
    })
  })
}

test('identity-less runtime predecessor of a known pool row is repaired through first identity', async () => {
  await firstIdentityScenario(production)
})

test('unknown pool row learns its account through rotation and first-identity publication', async () => {
  const f = await fixture({
    poolIdentity: false,
    runtime: 'unknown',
    metadata: { lastUsed: 1, quotaErrorGeneration: 2 },
  })
  expect(f.binding.identity).toBeUndefined()
  const result = await service(f).authorize(f.request())
  const proof = await f.proof()
  expect(result).toMatchObject({
    status: 'usable',
    source: 'rotated',
    binding: proof.binding,
    access: successor.access,
    validation: proof,
  })
  expect(await f.entry()).toEqual({
    binding: proof.binding,
    credentialValidation: proof,
    quotaErrorGeneration: 2,
  })
  expect([f.exchanges, f.lookups]).toEqual([1, 1])
})

for (const absentFile of [true, false]) {
  test(`genuinely missing runtime entry is created by known publication with ${absentFile ? 'no runtime file' : 'other runtime entries'}`, async () => {
    const f = await fixture({ runtime: 'missing' })
    if (!absentFile)
      await updateNativeRuntime(f.paths.runtime, f.paths.storageId, () => ({
        version: 1,
        storageId: f.paths.storageId,
        accounts: {},
      }))
    const result = await service(f).authorize(f.request())
    const proof = await f.proof()
    expect(result).toMatchObject({ status: 'usable', source: 'validated' })
    expect(await f.entry()).toEqual({
      binding: proof.binding,
      credentialValidation: proof,
    })
  })
}

test('unknown pool row without a captured runtime entry is never given a predecessor or served', async () => {
  const f = await fixture({ poolIdentity: false, runtime: 'missing' })
  const before = await snapshot(f.root)
  expect(Object.keys(before)).not.toContain('anthropic-auth-native-state.json')
  const result = await service(f).authorize(f.request())
  expect(result).toMatchObject({
    status: 'failed',
    persisted: true,
    reconciliationFailed: true,
  })
  // The replacement was saved before publication refused; nothing claims it
  // was rolled back, and no runtime entry was invented for it.
  expect((await f.row()).credential).toMatchObject({ access: successor.access })
  expect(await f.entry()).toBeUndefined()
  expect(await stages(f)).toEqual([])
  expect([f.exchanges, f.lookups]).toEqual([1, 1])
})

for (const change of ['reset', 'access', 'entry-binding'] as const) {
  test(`publication refuses after an intervening ${change} change and serves nothing`, async () => {
    const f = await fixture()
    f.lookup = async () => {
      if (change === 'reset')
        await updateNativeRuntime(
          f.paths.runtime,
          f.paths.storageId,
          (current) => {
            const entry = current.accounts.row
            if (entry) entry.refreshErrorClearedAt = 50
            return current
          },
        )
      if (change === 'access')
        await f.store.rotate('row', {
          ...original,
          access: 'synthetic-intervening-access',
        })
      if (change === 'entry-binding')
        await updateNativeRuntime(
          f.paths.runtime,
          f.paths.storageId,
          (current) => {
            current.accounts.row = {
              binding: {
                ...f.binding,
                identity: accountA,
                credentialEpoch: f.binding.credentialEpoch + 1,
              },
            }
            return current
          },
        )
      return accountA
    }
    const result = await service(f).authorize(f.request())
    expect(result).toMatchObject({
      status: 'failed',
      persisted: false,
      reconciliationFailed: true,
    })
    expect((await f.entry())?.credentialValidation).toBeUndefined()
    expect(await stages(f)).toEqual([])
    expect([f.exchanges, f.lookups]).toEqual([0, 1])
    leaksNoSecret(result)
  })
}

test('failure publication superseded by a reset is not validation and does not fail reconciliation', async () => {
  const f = await fixture({ expires: start - 1 })
  f.exchange = async () => {
    await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
      const entry = current.accounts.row
      if (entry) entry.refreshErrorClearedAt = 50
      return current
    })
    throw new ClaudeOAuthRefreshError(429, providerBody, '7')
  }
  f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time + 60_000 })
  const result = await service(f).authorize(f.request())
  expect(result).toEqual({
    status: 'failed',
    failure: {
      kind: 'provider',
      classification: 'transient',
      status: 429,
      retryAfter: 7,
    },
    persisted: false,
    reconciliationFailed: false,
  })
  expect(f.failures).toHaveLength(1)
  expect(await f.entry()).toEqual({
    binding: { ...f.binding, identity: accountA },
    refreshErrorClearedAt: 50,
  })
  expect(f.exchanges).toBe(1)
})

for (const operation of ['validation', 'failure'] as const) {
  test(`runtime storage fault during ${operation} publication is a reconciliation error`, async () => {
    const f = await fixture()
    // Change permissions during the provider callback, after admission read
    // the runtime entry. The subsequent publication must reject the now
    // group-readable runtime file instead of treating it as a row change.
    const fault = () => chmod(f.paths.runtime, 0o644)
    if (operation === 'validation')
      f.lookup = async () => {
        await fault()
        return accountA
      }
    else
      f.exchange = async () => {
        await fault()
        throw new ClaudeOAuthRefreshError(429, providerBody)
      }
    f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time + 1 })
    const result = await service(f).authorize(
      f.request(operation === 'failure' ? { intent: 'refresh' } : {}),
    )
    expect(result).toEqual(
      operation === 'validation'
        ? {
            status: 'failed',
            failure: { kind: 'caller-hook', classification: 'permanent' },
            persisted: false,
            reconciliationFailed: true,
          }
        : {
            status: 'failed',
            failure: {
              kind: 'provider',
              classification: 'transient',
              status: 429,
            },
            persisted: false,
            reconciliationFailed: true,
          },
    )
    await chmod(f.paths.runtime, 0o600)
    expect(await f.entry()).toEqual({
      binding: { ...f.binding, identity: accountA },
    })
    expect(await stages(f)).toEqual([])
  })
}

async function invalidGrantScenario(module: ServiceModule) {
  const f = await fixture()
  f.exchange = async () => {
    throw new ClaudeOAuthRefreshError(
      400,
      `{"error":"invalid_grant","detail":"${providerBody}"}`,
    )
  }
  f.policy = () => ({ checkedAt: f.time })
  const s = service(f, module)
  const result = await s.authorize(f.request({ intent: 'refresh' }))
  await named(
    'invalid grant is reported and recorded as permanent',
    async () => {
      expect(result).toEqual({
        status: 'failed',
        failure: {
          kind: 'provider',
          classification: 'invalid-grant',
          status: 400,
        },
        persisted: false,
        reconciliationFailed: false,
      })
      expect((await f.entry())?.lastRefreshError).toEqual({
        message: 'Local refresh failed',
        credentialFingerprint: fingerprintOf(original),
        permanent: true,
        checkedAt: start,
        accountIdentity: accountA,
        status: 400,
      })
    },
  )
  const next = await s.authorize(
    f.request({ rejectedAccessToken: original.access }),
  )
  await named('invalid grant blocks the next exchange', () => {
    expect(next).toEqual({
      status: 'refused',
      reason: 'invalid-grant',
      persisted: false,
    })
    expect(f.exchanges).toBe(1)
  })
  leaksNoSecret([result, next, await f.entry()])
}

test('provider 400 invalid_grant is recorded as permanent and blocks the next exchange', async () => {
  await invalidGrantScenario(production)
})

for (const [status, body, classification] of [
  [400, `{"error":"invalid_request","detail":"${providerBody}"}`, 'permanent'],
  [403, `{"error":"invalid_grant","detail":"${providerBody}"}`, 'permanent'],
  [429, providerBody, 'transient'],
] as const) {
  test(`provider ${status} ${classification} failure is recorded as retryable, never invalid grant`, async () => {
    const f = await fixture()
    f.exchange = async () => {
      throw new ClaudeOAuthRefreshError(status, body)
    }
    f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time + 60_000 })
    const s = service(f)
    expect(await s.authorize(f.request({ intent: 'refresh' }))).toEqual({
      status: 'failed',
      failure: { kind: 'provider', classification, status },
      persisted: false,
      reconciliationFailed: false,
    })
    expect(f.exchanges).toBe(1)
    expect(f.failures.map((input) => input.attribution)).toEqual([
      {
        kind: 'refresh-error',
        target: 'captured',
        subject: {
          binding: f.binding,
          credentialFingerprint: fingerprintOf(original),
          version: (await f.proof()).version,
        },
        permanent: false,
        message: 'Local refresh failed',
        status,
      },
    ])
    expect((await f.entry())?.lastRefreshError).toMatchObject({
      permanent: false,
      status,
      checkedAt: start,
      nextRetryAt: start + 60_000,
    })
    expect(await s.authorize(f.request({ intent: 'refresh' }))).toEqual({
      status: 'refused',
      reason: 'refresh-backoff',
      persisted: false,
    })
    expect(f.exchanges).toBe(1)
  })
}

test('failure policy equal to the failure time keeps the coordinator three bounded physical retries', async () => {
  const f = await fixture({ expires: start - 1 })
  f.exchange = async () => {
    f.time += 10
    throw new ClaudeOAuthRefreshError(503, providerBody)
  }
  f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time })
  const result = await service(f).authorize(f.request())
  expect(result).toEqual({
    status: 'failed',
    failure: { kind: 'provider', classification: 'transient', status: 503 },
    persisted: false,
    reconciliationFailed: false,
  })
  expect(f.exchanges).toBe(3)
  expect(f.failures.map((input) => input.observation.attempt)).toEqual([
    1, 2, 3,
  ])
  expect((await f.entry())?.lastRefreshError).toMatchObject({
    permanent: false,
    status: 503,
    checkedAt: start + 30,
    nextRetryAt: start + 30,
  })
})

test('future failure deadline suppresses the coordinator retry loop until the clock passes it', async () => {
  const f = await fixture({ expires: start - 1 })
  f.exchange = async () => {
    throw new ClaudeOAuthRefreshError(503, providerBody)
  }
  f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time + 1_000 })
  const s = service(f)
  // The stored deadline is read before attempt 2, so the job ends as a refusal
  // and no longer reports the 503 that caused it.
  expect(await s.authorize(f.request())).toEqual({
    status: 'refused',
    reason: 'refresh-backoff',
    persisted: false,
  })
  expect(f.exchanges).toBe(1)
  expect(f.failures.map((input) => input.observation.attempt)).toEqual([1])
  f.time += 999
  expect(await s.authorize(f.request())).toMatchObject({
    reason: 'refresh-backoff',
  })
  expect(f.exchanges).toBe(1)
  f.time += 1
  expect(await s.authorize(f.request())).toMatchObject({
    reason: 'refresh-backoff',
  })
  expect(f.exchanges).toBe(2)
})

async function unresolvedScenario(module: ServiceModule) {
  const f = await fixture()
  f.lookup = async () => {
    throw new Error('synthetic lookup outage')
  }
  f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time + 1_000 })
  const s = service(f, module)
  const result = await s.authorize(
    f.request({ rejectedAccessToken: original.access }),
  )
  await named(
    'unresolved lookup records validation retry, not proof',
    async () => {
      const committed = await f.proof()
      expect(result).toEqual({
        status: 'refused',
        reason: 'validation-backoff',
        persisted: true,
      })
      expect(await f.entry()).toEqual({
        binding: committed.binding,
        validationRetry: {
          subject: committed,
          checkedAt: start,
          nextRetryAt: start + 1_000,
        },
      })
      expect(f.failures.map((input) => input.attribution)).toEqual([
        { kind: 'validation-retry', target: 'committed', subject: committed },
      ])
    },
  )
  f.time += 1_000
  f.lookup = async () => accountA
  await named(
    'due validation retry validates the saved successor',
    async () => {
      expect(await s.authorize(f.request())).toMatchObject({
        status: 'usable',
        source: 'validated',
        access: successor.access,
      })
      expect([f.exchanges, f.lookups]).toEqual([1, 2])
    },
  )
}

test('persisted replacement with failed lookup records exact validation retry and no proof', async () => {
  await unresolvedScenario(production)
})

test('failure policy receives only frozen original observation and attribution', async () => {
  const f = await fixture()
  f.exchange = async () => {
    throw new ClaudeOAuthRefreshError(429, providerBody)
  }
  f.policy = () => ({ checkedAt: f.time, nextRetryAt: f.time + 1 })
  await service(f).authorize(f.request({ intent: 'refresh' }))
  // Assert afterward: authorization catches reconciliation callback errors.
  // An assertion inside the callback would become a result, not a failed test.
  const [input] = f.failures
  if (!input || f.failures.length !== 1)
    throw new Error('Failure policy was not called exactly once')
  expect(() => {
    ;(input.observation as { attempt: number }).attempt = 9
  }).toThrow(TypeError)
  expect(() => {
    ;(input.attribution.subject.binding as { rowId: string }).rowId = 'x'
  }).toThrow(TypeError)
  expect(Object.keys(input).sort()).toEqual(['attribution', 'observation'])
  expect(Object.isFrozen(input.observation.context?.subject.version)).toBe(true)
  expect(input.observation).toMatchObject({
    status: 'failed',
    attempt: 1,
    persisted: false,
    credentialFingerprint: fingerprintOf(original),
    failure: { kind: 'provider', classification: 'transient', status: 429 },
  })
  leaksNoSecret(input)
})

test('API-key rows fail closed in the coordinator without provider dispatch or runtime writes', async () => {
  const f = await fixture()
  await f.store.add({
    id: 'api',
    credential: {
      type: 'api',
      apiKey: 'synthetic-api-key',
      baseURL: 'https://api.anthropic.com',
    },
  })
  const read = await f.store.read()
  const row =
    read.status === 'ready'
      ? read.rows.find((candidate) => candidate.id === 'api')
      : undefined
  if (!row) throw new Error('Missing API-key row')
  const binding = captureNativeLocalPoolBinding(f.paths, row)
  const s = service(f)
  const before = await snapshot(f.root)
  const results: NativeRefreshResult[] = []
  for (const intent of ['serve', 'refresh'] as const)
    results.push(await s.authorize({ mode: 'local', intent, binding }))
  for (const result of results) {
    expect(result.status).not.toBe('usable')
    expect(JSON.stringify(result)).not.toContain('synthetic-api-key')
  }
  // An API-key row has no OAuth refresh token for the policy check to bind.
  // Refuse it without calling either OAuth exchange or account lookup.
  expect(results).toEqual([
    {
      status: 'failed',
      failure: { kind: 'caller-hook', classification: 'permanent' },
      persisted: false,
      reconciliationFailed: false,
    },
    {
      status: 'failed',
      failure: { kind: 'caller-hook', classification: 'permanent' },
      persisted: false,
      reconciliationFailed: false,
    },
  ])
  expect([f.exchanges, f.lookups, f.failures.length]).toEqual([0, 0, 0])
  expect(await snapshot(f.root)).toEqual(before)
})

test('cancellation before dispatch refuses without work and mid-exchange cancellation still saves and cleans up', async () => {
  const f = await fixture({ expires: start - 1 })
  const s = service(f)
  const aborted = new AbortController()
  aborted.abort()
  expect(await s.authorize(f.request({ signal: aborted.signal }))).toEqual({
    status: 'refused',
    reason: 'cancelled',
    persisted: false,
  })
  expect([f.exchanges, f.lookups]).toEqual([0, 0])
  const entered = gate()
  const release = gate()
  f.exchange = async () => {
    entered.open()
    await release.wait
    return successor
  }
  const controller = new AbortController()
  const lockFiles = async () =>
    (await readdir(f.root)).filter((name) => name.endsWith('.lock'))
  const pending = s.authorize(f.request({ signal: controller.signal }))
  await entered.wait
  // The paused exchange still owns its refresh/provider leases. Confirm their
  // files exist so the later empty-lock assertion actually proves cleanup.
  expect((await lockFiles()).length).toBeGreaterThan(0)
  controller.abort()
  release.open()
  expect(await pending).toEqual({
    status: 'refused',
    reason: 'cancelled',
    persisted: true,
  })
  // Cancellation cannot roll back the consumed refresh token. Keep the saved
  // successor and its completed account-validation proof for the next caller.
  const proof = await f.proof()
  expect(await f.entry()).toEqual({
    binding: proof.binding,
    credentialValidation: proof,
  })
  expect(await stages(f)).toEqual([])
  expect(await lockFiles()).toEqual([])
  expect(await s.authorize(f.request())).toMatchObject({
    status: 'usable',
    source: 'current',
    access: successor.access,
  })
  expect([f.exchanges, f.lookups]).toEqual([1, 1])
})

test('service exposes only authorize and accepts only own data option properties', async () => {
  const f = await fixture()
  const s = service(f)
  expect(Object.keys(s)).toEqual(['authorize'])
  expect(Object.isFrozen(s)).toBe(true)
  const base: Record<string, unknown> = {
    paths: f.paths,
    now: () => f.time,
    externalPolicy: () => ({ status: 'allowed' }),
    failurePolicy: () => ({ checkedAt: 0 }),
    refreshToken: async () => {
      throw new Error('Exchange forbidden')
    },
    resolveIdentity: async () => ({
      deviceId: 'synthetic-device',
      sessionId: 'synthetic-session',
      accountUuid: accountA,
    }),
  }
  const create = (options: unknown) =>
    Reflect.apply(production.createNativeLocalCredentialService, undefined, [
      options,
    ])
  expect(() => create(base)).not.toThrow()
  for (const [label, options] of [
    ['missing external policy', { ...base, externalPolicy: undefined }],
    ['missing failure policy', { ...base, failurePolicy: undefined }],
    ['non-function now', { ...base, now: 5 }],
    ['replaceable reconciliation', { ...base, reconcile: async () => {} }],
    ['replaceable admission', { ...base, readAdmission: async () => {} }],
    ['store hold hook', { ...base, hold: async () => {} }],
    [
      'incomplete paths',
      { ...base, paths: { ...f.paths, runtime: undefined } },
    ],
    [
      'getter failure policy',
      Object.defineProperty({ ...base }, 'failurePolicy', {
        enumerable: true,
        get: () => () => ({ checkedAt: 0 }),
      }),
    ],
    ['null options', null],
  ] as const) {
    let error: unknown
    try {
      create(options)
    } catch (caught) {
      error = caught
    }
    expect([label, error instanceof TypeError]).toEqual([label, true])
  }
  // Replacing a callback on the caller's object after construction has no effect.
  const options = { ...base, externalPolicy: () => ({ status: 'allowed' }) }
  const captured = create(options)
  options.externalPolicy = () => {
    throw new Error('replaced policy must not run')
  }
  expect(await captured.authorize(f.request())).toMatchObject({
    status: 'usable',
  })
})

// Run each authorization scenario on two temporary copies of the service:
// one unchanged and one with its named check removed. Their other dependencies
// stay identical, so the missing check must cause the failed assertion.
const guardBreaks: Array<{
  guard: string
  scenario: (module: ServiceModule) => Promise<void>
  from: string
  to: string
  assertion: string
}> = [
  {
    guard: 'authority journal guard',
    scenario: authorityScenario,
    from: '      await requireNativePoolAuthority(paths)\n',
    to: '',
    assertion: 'authority refusal precedes provider dispatch',
  },
  {
    guard: 'first-identity predecessor selection',
    scenario: firstIdentityScenario,
    from: 'if (predecessor && predecessor.identity === undefined)',
    to: 'if (false)',
    assertion: 'first-identity repair serves validated access',
  },
  {
    guard: 'known predecessor selection',
    scenario: knownRotationScenario,
    from: 'if (predecessor && predecessor.identity === undefined)',
    to: 'if (predecessor)',
    assertion: 'known rotation preserves metadata and records proof',
  },
  {
    guard: 'failure publisher dispatch',
    scenario: invalidGrantScenario,
    from: '    await publishNativeLocalRefreshFailure(paths, event, policy)\n',
    to: '',
    assertion: 'invalid grant is reported and recorded as permanent',
  },
  {
    guard: 'positive publication bootstrap gate',
    scenario: unresolvedScenario,
    from: "      event.bootstrap === 'resolved'\n",
    to: '      true\n',
    assertion: 'unresolved lookup records validation retry, not proof',
  },
]

for (const { guard, scenario, from, to, assertion } of guardBreaks) {
  test(`${guard} healthy owned copy passes its named assertion`, async () => {
    await scenario(await owned())
  })
  test(`${guard} removed from an owned copy fails ${assertion}`, async () => {
    const broken = await owned({ from, to })
    await expect(scenario(broken)).rejects.toThrow(`${assertion} failed`)
  })
}
