import { expect, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  mutateVaultRoster,
  projectVaultRoster,
  readVaultRoster,
} from '@cortexkit/common-auth/claustrum'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import type { NativeCustodyClient } from '../native-custody.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { readNativeRuntime, updateNativeRuntime } from '../native-runtime.ts'
import {
  acquireNativeVaultRuntime,
  createNativeVaultRuntime,
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
} from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup, gate } = createTestLifetimeSuite()
const uuid = '11111111-2222-4333-8444-555555555555'
const uuid2 = '22222222-2222-4333-8444-555555555555'
const id = 'oauth:anthropic'
const now = 1_000_000
type Row = Awaited<
  ReturnType<NativeCustodyClient['listScoped']>
>['rows'][number]
const listed: Row = {
  id,
  accountId: uuid,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  refreshAdapter: 'anthropic',
  serves: ['anthropic'],
  providerIds: [],
  state: 'active',
  operations: ['read'],
  recordVersion: 7,
  createdAtMs: null,
}

async function fixture() {
  const parent = new URL(
    '../../../../node_modules/.cache/native-vault-runtime/',
    import.meta.url,
  ).pathname
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fixture-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  const projected = projectVaultRoster(
    undefined,
    {
      view: 'initial',
      credentials: [
        {
          credentialId: id,
          credentialType: 'oauth',
          accountIdentity: uuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    { now },
  )
  const primaryRouteId = projected.rows[0]?.routeId
  if (!primaryRouteId) throw new Error('Missing fixture primary route')
  await store.updateSettings((settings) => {
    settings.mainAccountId = primaryRouteId
    settings.claustrum = {
      mode: 'claustrum',
      primaryAccount: { credentialId: id, accountId: uuid, state: 'active' },
    }
  })
  let rows: readonly Row[] = [listed]
  let version = 7
  let token = '01'.repeat(32)
  const counts = { connects: 0, lists: 0, gets: 0, closes: 0 }
  const reports: Parameters<
    NativeCustodyClient['reportAuthFailureScoped']
  >[0][] = []
  const client: NativeCustodyClient = {
    listScoped: async () => {
      counts.lists++
      return { view: `view-${rows.length}-${rows[0]?.accountId}`, rows }
    },
    getScoped: async (input) => {
      counts.gets++
      return {
        credentialId: input.credentialId,
        accountId: rows.find((row) => row.id === input.credentialId)?.accountId,
        material: `synthetic-bearer-${version}`,
        recordVersion: version,
        expiresAtMs: now + 3_600_000,
      }
    },
    reportAuthFailureScoped: async (report) => {
      reports.push(report)
    },
    close: () => {
      counts.closes++
    },
  }
  const options = {
    paths,
    host: 'opencode' as const,
    now: () => now,
    connect: async () => {
      counts.connects++
      return client
    },
    readToken: async () => ({ token, token_generation: 1 }),
  }
  const runtime = createNativeVaultRuntime(options)
  deferCleanup(() => runtime.close())
  return {
    paths,
    options,
    runtime,
    counts,
    reports,
    client,
    store,
    primaryRouteId,
    rows: (value: readonly Row[]) => {
      rows = value
    },
    version: (value: number) => {
      version = value
    },
    token: (value: string) => {
      token = value
    },
  }
}

test('delayed vault fallback GET rejects a newly expired or revoked roster row before HTTP dispatch', async () => {
  for (const state of ['expired', 'revoked']) {
    const f = await fixture()
    const work = { ...listed, id: 'oauth:anthropic:work', accountId: uuid2 }
    f.rows([listed, work])
    const entered = gate(),
      release = gate()
    const backend = {
      ...f.client,
      getScoped: async (
        input: Parameters<NativeCustodyClient['getScoped']>[0],
      ) => {
        const material = await f.client.getScoped(input)
        entered.open()
        await release.wait
        return material
      },
    }
    const runtime = createNativeVaultRuntime({
      ...f.options,
      connect: async () => backend,
    })
    deferCleanup(() => runtime.close())
    const roster = await runtime.refresh()
    const route = roster?.rows.find(
      (row) => row.credentialId === work.id,
    )?.routeId
    if (!route) throw new Error('Missing fixture fallback route')
    let http = 0
    const pending = runtime.authorize(route).then((receipt) => {
      http++
      return receipt
    })
    await entered.wait
    f.rows([listed, { ...work, state }])
    await runtime.refresh()
    release.open()
    await expect(pending).rejects.toMatchObject({ code: 'not-active' })
    expect(f.counts.gets).toBe(1)
    expect(http).toBe(0)
  }
})

test('vault main authorization preserves offline primary credential UUID and seeded route pin', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  f.rows([{ ...listed, accountId: uuid2 }])
  await f.runtime.refresh()
  let http = 0
  const pending = f.runtime.authorize('main').then((receipt) => {
    http++
    return receipt
  })
  await expect(pending).rejects.toMatchObject({ code: 'route-unavailable' })
  expect(f.counts.gets).toBe(0)
  expect(http).toBe(0)
  // Reusing the setup-selected primary route must not authorize a different
  // account UUID or vault credential than setup recorded.
  await mutateVaultRoster(f.paths.roster, (roster) => {
    if (!roster?.rows[0]) throw new Error('Missing fixture roster')
    roster.rows[0].routeId = f.primaryRouteId
    return { next: roster, result: undefined }
  })
  await expect(f.runtime.authorize('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  await mutateVaultRoster(f.paths.roster, (roster) => {
    if (!roster?.rows[0]) throw new Error('Missing fixture roster')
    roster.rows[0].accountIdentity = uuid
    roster.rows[0].credentialId = 'oauth:anthropic:other'
    return { next: roster, result: undefined }
  })
  await expect(f.runtime.authorize('main')).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(f.counts.gets).toBe(0)
})

test('persisted vault read never connects while first authorization discovers and every attempt gets a fresh receipt', async () => {
  const f = await fixture()
  expect(await f.runtime.read()).toBeUndefined()
  expect(f.counts.connects).toBe(0)
  const first = await f.runtime.authorize('main')
  const second = await f.runtime.authorize('main')
  expect(first).not.toBe(second)
  expect(f.counts).toEqual({ connects: 1, lists: 1, gets: 2, closes: 0 })
  expect(JSON.stringify(first)).not.toContain('synthetic-bearer')
  expect(first.accessToken).toBe('synthetic-bearer-7')
  expect(JSON.stringify(await f.runtime.read())).not.toContain(
    'synthetic-bearer',
  )
})

test('shared canonical storage and host consumer closes only on final release', async () => {
  const f = await fixture()
  const a = acquireNativeVaultRuntime(f.options)
  const b = acquireNativeVaultRuntime({ ...f.options, paths: { ...f.paths } })
  deferCleanup(() => {
    a.close()
    b.close()
  })
  await a.authorize('main')
  a.close()
  expect(f.counts.closes).toBe(0)
  await b.authorize('main')
  expect(f.counts.connects).toBe(1)
  b.close()
  expect(f.counts.closes).toBe(1)
  expect(() => a.read()).toThrow('closed')
})

test('vault close interrupts a pending connection and closes its late client exactly once', async () => {
  const f = await fixture()
  const connected = gate()
  const entered = gate()
  const lateClosed = gate()
  const client = {
    ...f.client,
    close: () => {
      f.client.close()
      lateClosed.open()
    },
  }
  const runtime = createNativeVaultRuntime({
    ...f.options,
    connect: async () => {
      entered.open()
      await connected.wait
      return client
    },
  })
  deferCleanup(() => runtime.close())
  const pending = runtime.authorize('main')
  await entered.wait
  runtime.close()
  await expect(pending).rejects.toMatchObject({ code: 'closed' })
  connected.open()
  await lateClosed.wait
  expect(f.counts.closes).toBe(1)
})

test('incomplete and unasserted vault lists retain prior accounts and cannot silently delete them', async () => {
  const f = await fixture()
  const first = await f.runtime.refresh()
  const routeId = first?.rows[0]?.routeId
  f.rows([{ ...listed, accountId: undefined }])
  const unclaimed = await f.runtime.refresh()
  expect(unclaimed?.rows[0]?.routeId).toBe(routeId)
  expect(unclaimed?.rows[0]?.unclaimed).toBe(true)
  f.rows([{ ...listed, id: '', accountId: undefined }])
  const malformed = await f.runtime.refresh()
  expect(malformed?.complete).toBe(false)
  expect(malformed?.rows).toHaveLength(1)
  f.rows([])
  expect((await f.runtime.refresh())?.rows).toHaveLength(0)
})

test('closing a pending vault list cannot publish its late result', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate(),
    settled = gate()
  const runtime = createNativeVaultRuntime({
    ...f.options,
    connect: async () => ({
      ...f.client,
      listScoped: async () => {
        entered.open()
        await release.wait
        settled.open()
        return { view: 'late', rows: [listed] }
      },
    }),
  })
  deferCleanup(() => runtime.close())
  const pending = runtime.refresh()
  await entered.wait
  runtime.close()
  await expect(pending).rejects.toMatchObject({ code: 'closed' })
  release.open()
  await settled.wait
  expect(await readVaultRoster(f.paths.roster)).toBeUndefined()
})

test('vault background 401 reports each exact rejected receipt and retries only once on strict newer version', async () => {
  const f = await fixture()
  const headers: string[] = []
  const transport: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      f.version(headers.length === 1 ? 8 : 9)
      return new Response('{}', { status: 401 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(f.runtime.fetchQuota('main', transport)).rejects.toThrow('401')
  expect(headers).toEqual([
    'Bearer synthetic-bearer-7',
    'Bearer synthetic-bearer-8',
  ])
  expect(f.reports.map((report) => report.recordVersion)).toEqual([7, 8])
  expect(f.counts.gets).toBe(2)
  const served = await f.runtime.authorize('main')
  f.version(9)
  expect(await f.runtime.prepareRetry(served)).toMatchObject({
    retry: false,
    reason: 'version-not-newer',
  })
  expect(await f.runtime.prepareRetry(served)).toMatchObject({ retry: false })
})

test('vault receipt ownership and version fences reject copied, replaced and delayed observations', async () => {
  const f = await fixture()
  const first = await f.runtime.authorize('main')
  f.version(8)
  const second = await f.runtime.authorize('main')
  expect(
    await f.runtime.publish(second, {
      quota: {
        scoped: [],
        checkedAt: now,
        source: 'poll',
        accountIdentity: uuid,
      },
    }),
  ).toBe(true)
  expect(await f.runtime.publish(first, { lastUsed: now + 1 })).toBe(false)
  await expect(
    f.runtime.publish({ ...second }, { lastUsed: now }),
  ).rejects.toMatchObject({ code: 'no-receipt' })
  const quota = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    quota.status === 'ready'
      ? quota.state.accounts[(await f.runtime.read())!.rows[0]!.routeId]
          ?.binding
      : undefined,
  ).toMatchObject({ recordVersion: 8 })
  f.rows([{ ...listed, accountId: uuid2 }])
  await f.runtime.refresh()
  expect(await f.runtime.publish(second, { lastUsed: now + 1 })).toBe(false)
})

test('vault quota/profile and atomic Prime lineage remain secret-free in durable runtime', async () => {
  const f = await fixture()
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) =>
      Response.json(
        String(input).endsWith('/profile')
          ? {
              organization: {
                organization_type: 'claude_pro',
                rate_limit_tier: 'default',
              },
            }
          : {},
      ),
    { preconnect: fetch.preconnect },
  )
  expect((await f.runtime.fetchQuota('main', transport)).scoped).toEqual([])
  expect(
    (await f.runtime.fetchProfile('main', transport)).accountIdentity,
  ).toBe(uuid)
  const receipt = await f.runtime.authorize('main')
  const lineages = await Promise.all([
    f.runtime.getOrCreateAuthLineage(receipt),
    f.runtime.getOrCreateAuthLineage(receipt),
  ])
  expect(lineages[0]).toBe(lineages[1])
  expect(await f.runtime.incrementPrimeUsage(receipt, { inputTokens: 2 })).toBe(
    true,
  )
  expect(
    await f.runtime.incrementPrimeUsage(receipt, { outputTokens: 3 }),
  ).toBe(true)
  const state = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
  expect(
    state.status === 'ready'
      ? Object.values(state.state.accounts)[0]?.prime
      : undefined,
  ).toEqual({ count: 2, inputTokens: 2, outputTokens: 3, since: now })
  expect(await readFile(f.paths.runtime, 'utf8')).not.toContain(
    'synthetic-bearer',
  )
})

test('seed publication outer ownership is checked again at actual producer rename', async () => {
  const f = await fixture()
  const input = {
    inventory: {
      view: 'seed-view',
      credentials: [
        {
          credentialId: id,
          credentialType: 'oauth' as const,
          accountIdentity: uuid,
          state: 'active',
        },
      ],
      skipped: [],
    },
    primary: { credentialId: id, accountIdentity: uuid },
    primaryRouteId: 'imported-main',
    legacyRows: [],
    disabledAccountIdentities: [],
    reservedRouteIds: [],
  }
  let assertions = 0
  await expect(
    publishNativeVaultRosterSeed(f.paths, input, {
      assertOwned: async () => {
        if (++assertions === 2)
          throw new Error('synthetic outer lease lost at rename')
      },
    }),
  ).rejects.toThrow('synthetic outer lease lost at rename')
  expect(assertions).toBe(2)
  expect(await readVaultRoster(f.paths.roster)).toBeUndefined()
  const seed = await publishNativeVaultRosterSeed(f.paths, input)
  expect(seed.rows[0]?.routeId).toBe('imported-main')
})

test('custody runtime seed rejects unowned publication and descriptor callbacks before any write', async () => {
  const f = await fixture()
  const roster = await f.runtime.refresh()
  const routeId = roster!.rows[0]!.routeId
  const before = await readFile(f.paths.runtime)
  const state = {
    version: 1 as const,
    storageId: f.paths.storageId,
    accounts: {
      [routeId]: {
        binding: {
          kind: 'custody' as const,
          storageId: f.paths.storageId,
          routeId,
          credentialId: id,
          accountIdentity: uuid,
          recordVersion: 7,
        },
        lastUsed: now,
      },
    },
  }
  await expect(
    publishNativeVaultRuntimeSeed(f.paths, state, {
      assertOwned: async () => {
        throw new Error('lost outer lease')
      },
    }),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  expect(await readFile(f.paths.runtime)).toEqual(before)
  let reads = 0
  Object.defineProperty(state.accounts[routeId], 'lastUsed', {
    get: () => {
      reads++
      return now
    },
    enumerable: true,
  })
  await expect(
    publishNativeVaultRuntimeSeed(f.paths, state),
  ).rejects.toMatchObject({ code: 'publication-refused' })
  expect(reads).toBe(0)
  expect(await readFile(f.paths.runtime)).toEqual(before)
})

test('vault route disable persists decline and a held roster prevents replaced-account runtime publication', async () => {
  const f = await fixture()
  const receipt = await f.runtime.authorize('main')
  await f.runtime.setEnabled('main', false)
  await f.runtime.refresh()
  await expect(f.runtime.authorize('main')).rejects.toMatchObject({
    code: 'route-declined',
  })
  await mutateVaultRoster(f.paths.roster, (current) => {
    if (!current) throw new Error('Missing fixture roster')
    current.rows[0]!.accountIdentity = uuid2
    return { next: current, result: undefined }
  })
  expect(await f.runtime.publish(receipt, { lastUsed: now })).toBe(false)
})

test('vault quota auth failures never arm quota backoff while 429 still does', async () => {
  for (const status of [401, 403, 429]) {
    const f = await fixture()
    const transport: typeof fetch = Object.assign(
      async () => new Response('synthetic-private-body', { status }),
      { preconnect: fetch.preconnect },
    )
    await expect(f.runtime.fetchQuota('main', transport)).rejects.toMatchObject(
      { status },
    )
    const state = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
    const error =
      state.status === 'ready'
        ? state.state.accounts[f.primaryRouteId]?.lastQuotaRefreshError
        : undefined
    if (status === 429)
      expect(error).toMatchObject({ status: 429, nextRetryAt: now + 60_000 })
    else expect(error).toBeUndefined()
  }
})

test('vault quota retry admits only after deferred body cleanup so decline prevents a second HTTP', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate()
  let http = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      if (++http === 1) {
        f.version(8)
        return new Response(
          new ReadableStream({
            cancel: async () => {
              entered.open()
              await release.wait
            },
          }),
          { status: 401 },
        )
      }
      return Response.json({})
    },
    { preconnect: fetch.preconnect },
  )
  const pending = f.runtime.fetchQuota('main', transport)
  await entered.wait
  await f.runtime.setEnabled('main', false)
  release.open()
  await expect(pending).rejects.toMatchObject({ status: 401 })
  expect(http).toBe(1)
  expect(f.counts.gets).toBe(1)
})

test('vault failed failure-report telemetry cannot block its one fresh retry or change rejected versions', async () => {
  const f = await fixture()
  const runtime = createNativeVaultRuntime({
    ...f.options,
    connect: async () => ({
      ...f.client,
      reportAuthFailureScoped: async (input) => {
        await f.client.reportAuthFailureScoped(input)
        throw new Error('synthetic telemetry unavailable')
      },
    }),
  })
  deferCleanup(() => runtime.close())
  let http = 0
  const transport: typeof fetch = Object.assign(
    async () => {
      http++
      f.version(http === 1 ? 8 : 9)
      return new Response('{}', { status: 401 })
    },
    { preconnect: fetch.preconnect },
  )
  await expect(runtime.fetchQuota('main', transport)).rejects.toMatchObject({
    status: 401,
  })
  expect(http).toBe(2)
  expect(f.reports.map((report) => report.recordVersion)).toEqual([7, 8])
})

test('vault quota success and failure cannot inherit another account runtime clear floor', async () => {
  for (const status of [200, 429]) {
    const f = await fixture()
    await f.runtime.refresh()
    await updateNativeRuntime(f.paths.runtime, f.paths.storageId, (current) => {
      current.accounts[f.primaryRouteId] = {
        binding: {
          kind: 'custody',
          storageId: f.paths.storageId,
          routeId: f.primaryRouteId,
          credentialId: id,
          accountIdentity: uuid2,
          recordVersion: 7,
        },
        quotaErrorClearedAt: now + 1_000_000,
      }
      return current
    })
    const transport: typeof fetch = Object.assign(
      async () => new Response('{}', { status }),
      { preconnect: fetch.preconnect },
    )
    if (status === 200) await f.runtime.fetchQuota('main', transport)
    else
      await expect(
        f.runtime.fetchQuota('main', transport),
      ).rejects.toMatchObject({ status: 429 })
    const state = await readNativeRuntime(f.paths.runtime, f.paths.storageId)
    const entry =
      state.status === 'ready'
        ? state.state.accounts[f.primaryRouteId]
        : undefined
    if (status === 200) expect(entry?.quotaErrorClearedAt).toBe(now)
    else expect(entry?.lastQuotaRefreshError?.checkedAt).toBe(now)
  }
})

/**
 * Capture the INFO records native runtimes emit on the `commands` channel,
 * starting from the info level, and restore the previous level and sink after
 * the test. Bun runs tests with NODE_ENV=test, under which the logger
 * delivers records only to this sink and writes no log file.
 */
function captureCommandLogs() {
  expect(process.env.NODE_ENV).toBe('test')
  const previousLevel = getLogLevel()
  const records: LogTestRecord[] = []
  setLogLevel('info')
  __setLogTestSink((record) => {
    if (record.channel === 'commands') records.push(record)
  })
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return {
    /** Message and payload of each record captured since the previous call. */
    take() {
      const taken = records.map(({ message, payload }) => ({
        message,
        payload,
      }))
      records.length = 0
      return taken
    },
  }
}

/** A native account runtime over the fixture's pool and vault roster. */
function accountRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: {
      now: f.options.now,
      connect: f.options.connect,
      readToken: f.options.readToken,
    },
  })
  deferCleanup(() => runtime.close())
  return runtime
}

test('vault setEnabled reports whether the route flag changed, judged on the roster under its lock', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  const row = async () => (await readVaultRoster(f.paths.roster))?.rows[0]

  expect(await f.runtime.setEnabled('main', false)).toBe(true)
  expect(await f.runtime.setEnabled('main', false)).toBe(false)
  expect((await row())?.enabled).toBe(false)
  expect((await readVaultRoster(f.paths.roster))?.declined).toEqual([
    { credentialId: id, accountIdentity: uuid },
  ])

  expect(await f.runtime.setEnabled('main', true)).toBe(true)
  expect(await f.runtime.setEnabled('main', true)).toBe(false)
  expect((await row())?.enabled).toBe(true)
  expect((await readVaultRoster(f.paths.roster))?.declined).toEqual([])

  await expect(
    f.runtime.setEnabled('missing-route', false),
  ).rejects.toMatchObject({ code: 'route-unavailable' })
})

test('two native runtimes disabling the same vault account log one change, judged under the roster lock', async () => {
  const f = await fixture()
  await f.runtime.refresh()
  const a = accountRuntime(f)
  const b = accountRuntime(f)
  const logs = captureCommandLogs()

  // Two operations disable the same account. The first reads it enabled; the
  // second completes the decline before the first writes, so the first
  // changes no enabled flag.
  const read = a.read.bind(a)
  let interleaved = false
  const readSpy = spyOn(a, 'read').mockImplementation(async () => {
    const snapshot = await read()
    if (!interleaved) {
      interleaved = true
      expect(snapshot.accounts.find((row) => row.id === 'main')?.enabled).toBe(
        true,
      )
      await b.setEnabled('main', false)
    }
    return snapshot
  })
  deferCleanup(() => readSpy.mockRestore())
  await a.setEnabled('main', false)
  readSpy.mockRestore()
  expect(interleaved).toBe(true)
  expect(logs.take()).toEqual([
    {
      message: 'account disabled',
      payload: expect.objectContaining({ id: 'main', enabled: false }),
    },
  ])

  // Removing a vault account declines it: the change is logged as a disable,
  // once, and removing it again changes nothing.
  await a.setEnabled('main', true)
  await a.remove('main')
  await a.remove('main')
  expect(logs.take()).toEqual([
    {
      message: 'account enabled',
      payload: expect.objectContaining({ id: 'main', enabled: true }),
    },
    {
      message: 'account disabled',
      payload: expect.objectContaining({ id: 'main', enabled: false }),
    },
  ])
})

test('vault account reorder logs once when the locked roster or stored order changes', async () => {
  const f = await fixture()
  f.rows([
    listed,
    { ...listed, id: 'oauth:anthropic:work', accountId: uuid2 },
    {
      ...listed,
      id: 'oauth:anthropic:personal',
      accountId: '33333333-2222-4333-8444-555555555555',
    },
  ])
  await f.runtime.refresh()
  const a = accountRuntime(f)
  const fallbacks = async () =>
    (await a.read()).accounts
      .filter((row) => row.id !== 'main')
      .map((row) => row.id)
  const [first, second] = await fallbacks()
  if (!first || !second) throw new Error('Missing fixture fallback routes')
  const logs = captureCommandLogs()

  await a.reorder([second, first], second)
  expect(await fallbacks()).toEqual([second, first])
  // Asking for the order already stored writes nothing new, so only the
  // reorder above is logged.
  await a.reorder([second, first], second)
  expect(logs.take()).toEqual([
    {
      message: 'account reordered',
      payload: expect.objectContaining({ id: second }),
    },
  ])
})
