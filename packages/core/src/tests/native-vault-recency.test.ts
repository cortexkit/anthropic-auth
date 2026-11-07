import { expect, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  mutateVaultRoster,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock, lockPathFor } from '@cortexkit/common-auth/fs'
import {
  acquireNativeAccountRuntime,
  createNativeAccountRuntime,
} from '../native-account-runtime.ts'
import type {
  NativeCustodyClient,
  NativeCustodyReceipt,
} from '../native-custody.ts'
import { fromNativeQuotaMap, nativeQuotaCodec } from '../native-quota-codec.ts'
import {
  isNativeRuntimeStagingName,
  NativeRuntimeError,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
  updateNativeRuntimeOptional,
} from '../native-runtime.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import {
  createNativeVaultRuntime,
  type NativeVaultRuntime,
  publishNativeVaultRuntimeSeed,
} from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const uuid2 = '22222222-2222-4333-8444-555555555555'
const id = 'oauth:anthropic'
const now = 1_000_000
// Used to assert receipt publication leaves roster writers independent.
const rosterWriteLock = 'claustrum-roster-write'
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]

function listing(recordVersion: number): Row {
  return {
    id,
    accountId: uuid,
    credentialType: 'oauth',
    categories: ['anthropic-native'],
    refreshAdapter: 'anthropic',
    serves: ['anthropic'],
    providerIds: [],
    state: 'active',
    operations: ['read'],
    recordVersion,
    createdAtMs: null,
  }
}

async function readBytes(path: string): Promise<Buffer | undefined> {
  return readFile(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined
    throw error
  })
}

/**
 * A vault enrollment whose synthetic Claustrum client serves one credential.
 * `advance` moves both the scoped listing and the served credential to a new
 * record version and runs discovery, as a vault rotation would.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-recency-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  await initializeNativeTestAuthority(paths)
  const vaultPaths = nativeVaultPaths(paths)
  const enrollmentFile = join(root, 'opencode-enrollment.json')
  const env = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: enrollmentFile,
  }
  await writeFile(
    enrollmentFile,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const store = createNativePoolStore({
    paths: vaultPaths,
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  let version = 1
  let rows: readonly Row[] = [listing(version)]
  const client: NativeCustodyClient = {
    listScoped: async () => ({
      view: `view-${rows[0]?.recordVersion}`,
      rows,
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
      material: `synthetic-bearer-${version}`,
      recordVersion: version,
      expiresAtMs: now + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const options = {
    paths,
    host: 'opencode' as const,
    env,
    now: () => now,
    connect: async () => client,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
  }
  const runtime = createNativeVaultRuntime(options)
  deferCleanup(() => runtime.close())
  return {
    vaultPaths,
    enrollmentFile,
    options,
    runtime,
    store,
    async advance(next: number, target: NativeVaultRuntime = runtime) {
      version = next
      rows = [listing(next)]
      const roster = await target.refresh()
      expect(roster?.rows.map((row) => row.credentialId)).toEqual([id])
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

for (const lastLease of [false, true]) {
  test(`shared bookkeeping ${lastLease ? 'aborts only at final lease close' : 'survives another lease disposal'}`, async () => {
    const f = await fixture()
    const waiting = gate()
    let watching = false
    const options = {
      paths: f.options.paths,
      host: 'opencode' as const,
      vault: {
        ...f.options,
        onLockEvent: (event: { name: string; type: string }) => {
          if (
            watching &&
            event.name === 'native-runtime' &&
            event.type === 'acquiring'
          )
            waiting.open()
        },
      },
    }
    const a = acquireNativeAccountRuntime(options)
    const b = acquireNativeAccountRuntime(options)
    deferCleanup(() => a.close())
    deferCleanup(() => b.close())
    expect(a.quotaObservations).toBe(b.quotaObservations)
    await a.vault.refresh()
    const receipt = await b.vault.authorize('main')
    const accountIdentity = receipt.assertedAccountIdentity
    if (!accountIdentity)
      throw new Error('Fixture receipt has no account identity')
    await a.vault.publish(receipt, { lastUsed: now })
    const holder = await acquireRefreshFileLock({
      path: f.vaultPaths.runtime,
      name: 'native-runtime',
      ttlMs: 10_000,
    })
    if (!holder) throw new Error('Runtime fixture lock unavailable')
    deferCleanup(() => holder.release())
    watching = true
    const publish = (runtime: typeof a, usedPercent: number) => {
      const quota = {
        source: 'headers' as const,
        accountIdentity,
        checkedAt: now + usedPercent,
        five_hour: {
          usedPercent,
          remainingPercent: 100 - usedPercent,
          checkedAt: now + usedPercent,
        },
      }
      return runtime.quotaObservations.publish(
        'main',
        {
          lineage: 'shared-fixture',
          accountUuid: accountIdentity,
          generalExhausted: false,
          entry: {
            quota,
            checkedAt: now + usedPercent,
            refreshAfter: now + 60_000,
          },
        },
        (signal) =>
          runtime.vault.publish(
            receipt,
            { quota, lastUsed: now + usedPercent },
            signal,
          ),
      )
    }
    if (lastLease) await a.close()
    const pending = publish(lastLease ? b : a, 25)
    trackDetached(pending)
    await waiting.wait
    const closingAt = performance.now()
    if (!lastLease) await a.drainQuotaPublications()
    await (lastLease ? b : a).close()
    expect(performance.now() - closingAt).toBeLessThan(1_750)
    await holder.assertOwned()
    if (lastLease) {
      await pending
      expect((await runtimeEntry(f))?.lastUsed).toBe(now)
    } else {
      const next = publish(b, 50)
      trackDetached(next)
      await holder.release()
      await Promise.all([pending, next])
      await b.close()
      const entry = await runtimeEntry(f)
      expect(entry?.lastUsed).toBe(now + 50)
      expect(fromNativeQuotaMap(entry?.quota).five_hour?.remainingPercent).toBe(
        50,
      )
    }
  }, 15_000)
}

/**
 * Pause the next vault runtime write after it opens its staging file, which is
 * after the writer's in-lock change and before its final checks and rename.
 * Other files, including lock owner files, open normally.
 */
function holdNextRuntimeStage(runtimePath: string) {
  const staged = gate()
  const release = gate()
  let holds = 0
  const original = filesystem.open
  const spy = spyOn(filesystem, 'open').mockImplementation(
    async (path, flags, mode) => {
      if (
        holds === 0 &&
        typeof path === 'string' &&
        dirname(path) === dirname(runtimePath) &&
        isNativeRuntimeStagingName(runtimePath, basename(path))
      ) {
        holds++
        staged.open()
        await release.wait
      }
      return original(path, flags, mode)
    },
  )
  deferCleanup(() => spy.mockRestore())
  return {
    staged: staged.wait,
    holds: () => holds,
    release() {
      spy.mockRestore()
      release.open()
    },
  }
}

/**
 * Model a host that has already received an authorized 200 response and
 * records when the account was last used before returning it. The recency
 * write for receipt version 1 is held at its staged file while the same
 * runtime discovers and authorizes version 2; `interfere` then changes
 * something else before the write resumes.
 */
async function recencyOvertakenBeforeRename(
  f: Fixture,
  patch: Parameters<NativeVaultRuntime['publish']>[1],
  interfere: () => Promise<void> = async () => {},
) {
  const first = await f.runtime.authorize('main')
  expect(first.recordVersion).toBe(1)
  expect(first.accessToken).toBe('synthetic-bearer-1')
  expect(await f.runtime.publish(first, { lastUsed: now })).toBe(true)
  await f.advance(2)
  const runtimeBefore = await readBytes(f.vaultPaths.runtime)
  const rosterBefore = await readBytes(f.vaultPaths.roster)
  expect(runtimeBefore).toBeDefined()
  expect(rosterBefore).toBeDefined()
  const hold = holdNextRuntimeStage(f.vaultPaths.runtime)
  const response = (async () => {
    const response = new Response('authorized body', { status: 200 })
    const recorded = await f.runtime.publish(first, patch)
    return { response, recorded }
  })()
  const settled = Promise.allSettled([response])
  // Register the write with the test lifetime before anything below can
  // throw, so a body that fails or times out still waits for it before the
  // fixture's files are removed.
  trackDetached(settled)
  let successor: NativeCustodyReceipt
  try {
    // Wait for the hold or for the write to finish without reaching it; the
    // hold count below turns the second case into an assertion failure.
    await Promise.race([hold.staged, settled])
    expect(hold.holds()).toBe(1)
    successor = await f.runtime.authorize('main')
    await interfere()
  } finally {
    // Resume the held write and wait for it on every path, so a failed
    // assertion or interference never leaves it running past this helper.
    hold.release()
    await settled
  }
  const [outcome] = await settled
  expect(successor.recordVersion).toBe(2)
  expect(successor.accessToken).toBe('synthetic-bearer-2')
  expect(successor.credentialId).toBe(first.credentialId)
  expect(successor.assertedAccountIdentity).toBe(uuid)
  return { first, successor, outcome, runtimeBefore, rosterBefore }
}

async function runtimeEntry(f: Fixture) {
  const read = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  if (read.status !== 'ready') throw new Error('Missing fixture runtime')
  const entries = Object.values(read.state.accounts)
  expect(entries).toHaveLength(1)
  return entries[0]
}

function expectRefused(outcome: PromiseSettledResult<unknown>) {
  expect(outcome.status).toBe('rejected')
  const reason = outcome.status === 'rejected' ? outcome.reason : undefined
  expect(reason).toBeInstanceOf(NativeRuntimeError)
  expect(reason).toMatchObject({ code: 'publication-refused' })
}

async function stagingLeftovers(runtimePath: string) {
  return (await filesystem.readdir(dirname(runtimePath))).filter((name) =>
    isNativeRuntimeStagingName(runtimePath, name),
  )
}

test('a lastUsed write overtaken by a newer vault receipt before its final rename resolves false and keeps the response', async () => {
  const f = await fixture()
  const held = await recencyOvertakenBeforeRename(f, { lastUsed: now + 5 })
  expect(held.outcome.status).toBe('fulfilled')
  const delivered =
    held.outcome.status === 'fulfilled' ? held.outcome.value : undefined
  expect(delivered?.recorded).toBe(false)
  expect(delivered?.response.status).toBe(200)
  expect(await delivered?.response.text()).toBe('authorized body')
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(held.runtimeBefore)
  expect(await readBytes(f.vaultPaths.roster)).toEqual(held.rosterBefore)
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 1 },
    lastUsed: now,
  })
  // The successor records its own use. A later version 1 write is then
  // dropped by the early version check and leaves the successor untouched.
  expect(await f.runtime.publish(held.successor, { lastUsed: now + 6 })).toBe(
    true,
  )
  const successorBytes = await readBytes(f.vaultPaths.runtime)
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 2 },
    lastUsed: now + 6,
  })
  expect(await f.runtime.publish(held.first, { lastUsed: now + 7 })).toBe(false)
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(successorBytes)
})

test('a lastUsed write behind a newer persisted vault entry resolves false without changing it', async () => {
  const f = await fixture()
  const first = await f.runtime.authorize('main')
  expect(first.recordVersion).toBe(1)
  // Another process discovers and records version 2. This runtime has issued
  // only version 1, so its write passes the early check and meets the newer
  // entry inside the runtime lock instead.
  const peer = createNativeVaultRuntime(f.options)
  deferCleanup(() => peer.close())
  await f.advance(2, peer)
  const successor = await peer.authorize('main')
  expect(successor.recordVersion).toBe(2)
  expect(successor.accessToken).toBe('synthetic-bearer-2')
  expect(await peer.publish(successor, { lastUsed: now + 6 })).toBe(true)
  const before = await readBytes(f.vaultPaths.runtime)
  const [outcome] = await Promise.allSettled([
    f.runtime.publish(first, { lastUsed: now + 7 }),
  ])
  expect(outcome).toEqual({ status: 'fulfilled', value: false })
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(before)
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 2 },
    lastUsed: now + 6,
  })
})

test('a vault publication waiting for the runtime lock does not delay another runtime roster writer', async () => {
  const f = await fixture()
  const waiting = gate()
  let acquiring = false
  const publisher = createNativeVaultRuntime({
    ...f.options,
    onLockEvent: (event) => {
      if (event.name === 'native-runtime' && event.type === 'acquiring') {
        acquiring = true
        waiting.open()
      }
    },
  })
  deferCleanup(() => publisher.close())
  const peer = createNativeVaultRuntime(f.options)
  deferCleanup(() => peer.close())
  const receipt = await publisher.authorize('main')
  const locked = gate()
  const release = gate()
  // This is the real runtime file lock, with its normal renewal and timeout.
  const holder = updateNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
    async (current) => {
      locked.open()
      await release.wait
      return current
    },
  )
  const held = Promise.allSettled([holder])
  trackDetached(held)
  let publication: PromiseSettledResult<boolean>[] = []
  let writer: PromiseSettledResult<boolean>[] = []
  try {
    await Promise.race([locked.wait, held])
    expect(
      await readBytes(lockPathFor(f.vaultPaths.runtime, 'native-runtime')),
    ).toBeDefined()
    const pending = Promise.allSettled([
      publisher.publish(receipt, { lastUsed: now + 5 }),
    ])
    trackDetached(pending)
    await Promise.race([waiting.wait, pending])
    expect(acquiring).toBe(true)
    // Await the roster writer with its normal five-second acquisition wait,
    // while the runtime lock remains held. Releasing it first hides nesting.
    writer = await Promise.allSettled([peer.setEnabled('main', false)])
    release.open()
    publication = await pending
  } finally {
    release.open()
    await held
  }
  expect(writer[0]?.status).toBe('fulfilled')
  expect(writer[0]?.status === 'fulfilled' && writer[0].value).toBe(true)
  expect(publication).toEqual([{ status: 'fulfilled', value: true }])
  expect(await runtimeEntry(f)).toMatchObject({ lastUsed: now + 5 })
}, 20_000)

test('a roster account replacement before the runtime rename refuses publication', async () => {
  const f = await fixture()
  const receipt = await f.runtime.authorize('main')
  expect(await f.runtime.publish(receipt, { lastUsed: now })).toBe(true)
  const before = await readBytes(f.vaultPaths.runtime)
  const hold = holdNextRuntimeStage(f.vaultPaths.runtime)
  const pending = Promise.allSettled([
    f.runtime.publish(receipt, { lastUsed: now + 5 }),
  ])
  trackDetached(pending)
  try {
    await Promise.race([hold.staged, pending])
    expect(hold.holds()).toBe(1)
    // Model another process's atomic roster publication, independently of the
    // current process's in-memory receipt and settings.
    const roster = JSON.parse(
      (await readBytes(f.vaultPaths.roster))!.toString(),
    )
    roster.rows[0].accountIdentity = uuid2
    const stage = `${f.vaultPaths.roster}.replacement`
    await writeFile(stage, JSON.stringify(roster), { mode: 0o600 })
    await filesystem.rename(stage, f.vaultPaths.roster)
  } finally {
    hold.release()
    await pending
  }
  const [outcome] = await pending
  expectRefused(outcome!)
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(before)
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
})

test('a staged runtime seed does not delay another runtime roster writer', async () => {
  const f = await fixture()
  const receipt = await f.runtime.authorize('main')
  await f.runtime.publish(receipt, { lastUsed: now })
  const state = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  if (state.status !== 'ready') throw new Error('Missing fixture runtime')
  const hold = holdNextRuntimeStage(f.vaultPaths.runtime)
  const seed = Promise.allSettled([
    publishNativeVaultRuntimeSeed(f.vaultPaths, state.state),
  ])
  trackDetached(seed)
  const peer = createNativeVaultRuntime(f.options)
  deferCleanup(() => peer.close())
  let writer: PromiseSettledResult<boolean>[] = []
  try {
    await Promise.race([hold.staged, seed])
    expect(hold.holds()).toBe(1)
    writer = await Promise.allSettled([peer.setEnabled('main', false)])
  } finally {
    hold.release()
    await seed
  }
  expect(writer).toEqual([{ status: 'fulfilled', value: true }])
  expect(await seed).toEqual([{ status: 'fulfilled', value: undefined }])
}, 20_000)

test('a runtime seed refuses an account replacement before rename', async () => {
  const f = await fixture()
  const receipt = await f.runtime.authorize('main')
  await f.runtime.publish(receipt, { lastUsed: now })
  const state = await readNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
  )
  if (state.status !== 'ready') throw new Error('Missing fixture runtime')
  const before = await readBytes(f.vaultPaths.runtime)
  const hold = holdNextRuntimeStage(f.vaultPaths.runtime)
  const seed = Promise.allSettled([
    publishNativeVaultRuntimeSeed(f.vaultPaths, state.state),
  ])
  trackDetached(seed)
  try {
    await Promise.race([hold.staged, seed])
    expect(hold.holds()).toBe(1)
    const roster = (await readVaultRoster(f.vaultPaths.roster))!
    roster.rows[0]!.accountIdentity = uuid2
    const stage = `${f.vaultPaths.roster}.replacement`
    await writeFile(stage, JSON.stringify(roster), { mode: 0o600 })
    await filesystem.rename(stage, f.vaultPaths.roster)
  } finally {
    hold.release()
    await seed
  }
  expectRefused((await seed)[0]!)
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(before)
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
})

test('receipt mutation cannot retain lineage or Prime from an unrelated credential for the same account', async () => {
  const f = await fixture()
  const receipt = await f.runtime.authorize('main')
  const previousLineage = await f.runtime.getOrCreateAuthLineage(receipt)
  await f.runtime.incrementPrimeUsage(receipt, { inputTokens: 123 })
  await updateNativeRuntime(
    f.vaultPaths.runtime,
    f.vaultPaths.storageId,
    (current) => {
      const entry = Object.values(current.accounts)[0]!
      if (entry.binding.kind !== 'custody')
        throw new Error('Missing fixture custody binding')
      entry.binding.credentialId = 'unrelated-credential'
      return current
    },
  )
  expect(await f.runtime.getOrCreateAuthLineage(receipt)).not.toBe(
    previousLineage,
  )
  expect((await runtimeEntry(f))?.prime).toBeUndefined()
  expect(await f.runtime.incrementPrimeUsage(receipt)).toBe(true)
  expect((await runtimeEntry(f))?.prime?.count).toBe(1)
})

test('a primary pin waiting for settings locks does not delay another runtime roster writer', async () => {
  const f = await fixture()
  const initial = await f.runtime.refresh()
  const routeId = initial!.rows[0]!.routeId
  await f.store.updateSettings((settings) => {
    delete settings.mainAccountId
    delete settings.claustrum
  })
  const waiting = gate()
  let contended = false
  const publisher = createNativeVaultRuntime({
    ...f.options,
    onLockEvent: (event) => {
      if (event.name === 'pool-config' && event.type === 'contended') {
        contended = true
        waiting.open()
      }
    },
  })
  deferCleanup(() => publisher.close())
  const peer = createNativeVaultRuntime(f.options)
  deferCleanup(() => peer.close())
  const locked = gate()
  const release = gate()
  const held = Promise.allSettled([
    f.store.updateSettings(async (settings) => {
      locked.open()
      await release.wait
      return settings
    }),
  ])
  trackDetached(held)
  let writer: PromiseSettledResult<boolean>[] = []
  let pin: PromiseSettledResult<unknown>[] = []
  try {
    await Promise.race([locked.wait, held])
    const pending = Promise.allSettled([publisher.refresh()])
    trackDetached(pending)
    await Promise.race([waiting.wait, pending])
    expect(contended).toBe(true)
    writer = await Promise.allSettled([peer.setEnabled(routeId, false)])
    release.open()
    pin = await pending
  } finally {
    release.open()
    await held
  }
  expect(writer).toEqual([{ status: 'fulfilled', value: true }])
  expect(pin[0]?.status).toBe('fulfilled')
  const roster = await readVaultRoster(f.vaultPaths.roster)
  const settings = await f.store.readSettings()
  expect(settings.status === 'ready' && settings.settings.mainAccountId).toBe(
    roster?.rows[0]?.routeId,
  )
}, 20_000)

for (const replacement of ['account', 'credential', 'removed'] as const)
  test(`a roster pin ${replacement} after the final recheck cannot lend stale runtime metadata to its successor`, async () => {
    const f = await fixture()
    const receipt = await f.runtime.authorize('main')
    const lineage = await f.runtime.getOrCreateAuthLineage(receipt)
    await f.runtime.incrementPrimeUsage(receipt, { inputTokens: 123 })
    const error = {
      message: 'synthetic failure',
      checkedAt: now,
      nextRetryAt: now + 60_000,
      retryCount: 2,
      status: 429,
      accountIdentity: uuid,
    }
    await updateNativeRuntime(
      f.vaultPaths.runtime,
      f.vaultPaths.storageId,
      (current) => {
        const entry = Object.values(current.accounts)[0]!
        entry.lastRefreshedAt = now
        entry.lastRefreshError = error
        entry.refreshErrorClearedAt = now - 1
        return current
      },
    )
    const original = filesystem.rename
    let changed = false
    const spy = spyOn(filesystem, 'rename').mockImplementation(
      async (from, to) => {
        if (to === f.vaultPaths.runtime && !changed) {
          changed = true
          // The roster changes after the pre-rename check, so the old entry may
          // still be written. Reads check current roster identity and credential
          // before using any of its quota, recency, errors/backoff, lineage,
          // Prime or binding. A mismatch costs an inert write, not inherited state.
          await mutateVaultRoster(f.vaultPaths.roster, (roster) => {
            if (!roster) throw new Error('Missing fixture roster')
            if (replacement === 'removed') roster.rows = []
            else if (replacement === 'account')
              roster.rows[0]!.accountIdentity = uuid2
            else {
              roster.rows[0]!.credentialId = 'replacement-credential'
              roster.rows[0]!.aliases = []
            }
            return { next: roster, result: undefined }
          })
        }
        return original(from, to)
      },
    )
    deferCleanup(() => spy.mockRestore())
    expect(
      await f.runtime.publish(receipt, {
        lastUsed: now + 5,
        quota: { scoped: [], checkedAt: now, accountIdentity: uuid },
        lastQuotaRefreshError: error,
        quotaErrorClearedAt: now - 1,
        quotaErrorGeneration: 3,
        profile: {
          tier: 'max',
          orgType: 'team',
          checkedAt: now,
          accountIdentity: uuid,
        },
      }),
    ).toBe(true)
    spy.mockRestore()
    expect(changed).toBe(true)
    // Confirm the stale entry reached disk; an early refusal would not test
    // whether reads reject metadata that no longer matches the current roster.
    expect(await runtimeEntry(f)).toMatchObject({
      binding: { accountIdentity: uuid, credentialId: id },
      lastUsed: now + 5,
      authLineageId: lineage,
      prime: { count: 1, inputTokens: 123 },
      lastQuotaRefreshError: error,
    })
    if (replacement === 'account')
      await f.store.updateSettings((settings) => {
        settings.claustrum = {
          primaryAccount: { credentialId: id, accountId: uuid2 },
        }
      })
    const facade = createNativeAccountRuntime({
      paths: f.options.paths,
      host: 'opencode',
      vault: f.options,
    })
    deferCleanup(async () => {
      await facade.drainQuotaPublications()
      await facade.close()
    })
    const snapshot = await facade.read()
    if (replacement === 'removed') expect(snapshot.accounts).toHaveLength(0)
    else {
      const account = snapshot.accounts[0]!
      expect(account.accountIdentity).toBe(
        replacement === 'account' ? uuid2 : uuid,
      )
      for (const field of [
        'quota',
        'lastUsed',
        'lastRefreshedAt',
        'lastQuotaRefreshError',
        'lastRefreshError',
        'profile',
        'prime',
        'binding',
      ] as const)
        expect(account[field]).toBeUndefined()
    }
    expect(snapshot.policyStorage.prime?.mainAuthLineageId).toBeUndefined()
    expect(
      snapshot.policyStorage.quota?.mainQuotaErrorClearedAt,
    ).toBeUndefined()
    expect(
      snapshot.policyStorage.quota?.mainQuotaErrorGeneration,
    ).toBeUndefined()
    expect(
      snapshot.policyStorage.refresh?.mainRefreshErrorClearedAt,
    ).toBeUndefined()
  })

test('mixed metadata overtaken before its final rename still refuses publication', async () => {
  const f = await fixture()
  const held = await recencyOvertakenBeforeRename(f, {
    lastUsed: now + 5,
    quotaErrorClearedAt: now,
  })
  expectRefused(held.outcome)
  expect(await readBytes(f.vaultPaths.runtime)).toEqual(held.runtimeBefore)
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
})

const fatalDuringHold: ReadonlyArray<
  readonly [string, (f: Fixture) => Promise<void>]
> = [
  [
    'account replacement',
    async (f) => {
      const replaced = await f.store.updateSettings((settings) => {
        settings.claustrum = {
          primaryAccount: { credentialId: id, accountId: uuid2 },
        }
      })
      expect(replaced.outcome).toBe('updated')
    },
  ],
  ['custody loss', (f) => rm(f.enrollmentFile)],
  [
    'runtime lease refusal',
    async (f) => {
      const lock = lockPathFor(f.vaultPaths.runtime, 'native-runtime')
      const owner: unknown = JSON.parse(await readFile(lock, 'utf8'))
      expect(owner).toMatchObject({ ownerId: expect.any(String) })
      await writeFile(
        lock,
        `${JSON.stringify({ ownerId: 'synthetic-other-owner', expiresAt: 0 })}\n`,
      )
    },
  ],
]

for (const [name, interfere] of fatalDuringHold)
  test(`${name} while an overtaken lastUsed write is staged still refuses publication`, async () => {
    const f = await fixture()
    const held = await recencyOvertakenBeforeRename(
      f,
      { lastUsed: now + 5 },
      () => interfere(f),
    )
    expectRefused(held.outcome)
    expect(await readBytes(f.vaultPaths.runtime)).toEqual(held.runtimeBefore)
    expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
  })

test('an optional runtime write publishes, withdraws without writing, or refuses by its final check', async () => {
  const f = await fixture()
  const { runtime: path, storageId } = f.vaultPaths
  const used = (lastUsed: number) => (current: NativeRuntimeState) => {
    current.accounts.route = {
      binding: {
        kind: 'custody',
        storageId,
        routeId: 'route',
        credentialId: id,
        accountIdentity: uuid,
        recordVersion: 1,
      },
      lastUsed,
    }
    return current
  }
  await updateNativeRuntime(path, storageId, used(now))
  const before = await readBytes(path)
  expect(
    await updateNativeRuntimeOptional(path, storageId, used(now + 1), {
      beforeRename: async () => 'skip',
    }),
  ).toEqual({ status: 'skipped' })
  expect(await readBytes(path)).toEqual(before)
  expect(await stagingLeftovers(path)).toEqual([])
  const [refused] = await Promise.allSettled([
    updateNativeRuntimeOptional(path, storageId, used(now + 2), {
      beforeRename: async () => {
        throw new Error('synthetic final check failure')
      },
    }),
  ])
  expectRefused(refused)
  expect(await readBytes(path)).toEqual(before)
  expect(await stagingLeftovers(path)).toEqual([])
  const published = await updateNativeRuntimeOptional(
    path,
    storageId,
    used(now + 3),
    { beforeRename: async () => 'publish' },
  )
  expect(published.status).toBe('published')
  expect(await runtimeEntry(f)).toMatchObject({ lastUsed: now + 3 })
})

test('a failure while a lastUsed write is held still waits for that write before the helper returns', async () => {
  const f = await fixture()
  const failure = new Error('synthetic interference failure')
  const [helper] = await Promise.allSettled([
    recencyOvertakenBeforeRename(f, { lastUsed: now + 5 }, async () => {
      // The staged write owns only the runtime lock. Prove that lock exists
      // before checking its release, rather than checking an unused path.
      expect(
        await readBytes(lockPathFor(f.vaultPaths.roster, rosterWriteLock)),
      ).toBeUndefined()
      expect(
        await readBytes(lockPathFor(f.vaultPaths.runtime, 'native-runtime')),
      ).toBeDefined()
      throw failure
    }),
  ])
  expect(helper).toEqual({ status: 'rejected', reason: failure })
  // The runtime lock and staging file are gone only if the helper waited for
  // the held write. Receipt publication must never own the roster lock.
  expect(
    await readBytes(lockPathFor(f.vaultPaths.roster, rosterWriteLock)),
  ).toBeUndefined()
  expect(
    await readBytes(lockPathFor(f.vaultPaths.runtime, 'native-runtime')),
  ).toBeUndefined()
  expect(await stagingLeftovers(f.vaultPaths.runtime)).toEqual([])
  // The write resumed after version 2 was issued, so it was skipped.
  expect(await runtimeEntry(f)).toMatchObject({
    binding: { recordVersion: 1 },
    lastUsed: now,
  })
})
