import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as claustrum from '@cortexkit/common-auth/claustrum'
import * as locks from '@cortexkit/common-auth/fs'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { logger } from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import {
  createNativeCustody,
  type NativeCustodyClient,
  type NativeCustodyOptions,
} from '../native-custody.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { createNativeMenuExecutor } from '../native-menu-executor.ts'
import * as runtimeWriter from '../native-runtime.ts'
import {
  nativeRuntimeConnectionFile,
  nativeRuntimeStorageKey,
} from '../native-runtime-registry.ts'
import { createNativeUi } from '../native-ui.ts'
import { disconnectNativeVaultForHost } from '../native-vault-connection.ts'
import * as hostAuthority from '../native-vault-host.ts'
import { isVaultHosted } from '../native-vault-host.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { createNativeVaultRuntime } from '../native-vault-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
import { insulaBackground } from './insula-watch-fixture.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'

const symbol = Symbol.for('cortexkit.vault')
const globals = globalThis as unknown as Record<symbol, unknown>
const priorAccessor = globals[symbol]
const cleanup: (() => unknown | Promise<unknown>)[] = []
const relays: { clients: NativeCustodyClient[]; closed: number[] }[] = []
beforeEach(() => hostAuthority.resetVaultHostAuthorityForTests?.())
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  delete process.env.CORTEXKIT_VAULT_HOST
  if (priorAccessor === undefined) delete globals[symbol]
  else globals[symbol] = priorAccessor
  hostAuthority.resetVaultHostAuthorityForTests?.()
  for (const relay of relays.splice(0)) {
    expect(relay.closed.toSorted()).toEqual(
      relay.clients.map((_, index) => index),
    )
  }
})
const accountId = '11111111-2222-4333-8444-555555555555'
const credentialId = 'oauth:anthropic'
const now = 1_000_000
function client(connectionFile = 'host-relay'): NativeCustodyClient {
  return {
    listScoped: mock(async () => ({
      view: 'same-view',
      rows: [
        {
          id: credentialId,
          accountId,
          credentialType: 'oauth',
          categories: ['anthropic-native'],
          refreshAdapter: 'anthropic',
          serves: ['anthropic'],
          providerIds: [],
          state: 'active',
          operations: ['read'],
          recordVersion: 7,
          createdAtMs: null,
        },
      ],
      grants: undefined,
      grantTuples: undefined,
    })),
    getScoped: mock(async () => ({
      credentialId,
      accountId,
      material: 'synthetic-host-bearer',
      recordVersion: 7,
      expiresAtMs: now + 3_600_000,
    })),
    reportAuthFailureScoped: mock(async () => {}),
    close: mock(() => {}),
    insula: {
      connectionFile,
      getUsage: mock(async () => ({
        result: [],
        completeProviders: ['claude'],
      })),
    },
  }
}
function host(
  source: NativeCustodyClient | ((index: number) => NativeCustodyClient),
) {
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  const clients: NativeCustodyClient[] = []
  const closed: number[] = []
  relays.push({ clients, closed })
  const accessor = mock((id: string) => {
    expect(id).toBe('anthropic-auth')
    const index = clients.length
    const owned = typeof source === 'function' ? source(index) : source
    const fresh: NativeCustodyClient = {
      listScoped: (...args) => owned.listScoped(...args),
      getScoped: (...args) => owned.getScoped(...args),
      reportAuthFailureScoped: (...args) =>
        owned.reportAuthFailureScoped(...args),
      ...(owned.insula && { insula: owned.insula }),
      ...(owned.watchScoped && {
        watchScoped: (
          ...args: Parameters<NonNullable<NativeCustodyClient['watchScoped']>>
        ) => owned.watchScoped!(...args),
      }),
      close() {
        closed.push(index)
        owned.close()
      },
    }
    clients.push(fresh)
    return fresh
  })
  globals[symbol] = accessor
  return Object.assign(accessor, { clients, closed })
}
async function fixture(timers?: {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}) {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-host-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const paths = await resolveNativePoolPaths(join(root, 'anthropic-auth.json'))
  await initializeNativeTestAuthority(paths)
  const env: NodeJS.ProcessEnv = {
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
  }
  const localFiles = [
    paths.config,
    paths.state,
    paths.runtime,
    paths.roster,
    paths.journal,
    paths.legacyConfig,
    paths.legacyState,
  ]
  const bytes = () =>
    Promise.all(
      localFiles.map(async (path) => {
        try {
          return await readFile(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }),
    )
  const before = await bytes()
  const native = client(join(root, 'same-connection.json'))
  const relay = client(join(root, 'same-connection.json'))
  const connect = mock(async () => native)
  const readToken = mock(async () => ({
    token: '01'.repeat(32),
    token_generation: 1,
  }))
  const refreshToken = mock(async () => {
    throw new Error('local refresh forbidden')
  })
  let clock = now
  const options: Parameters<typeof createNativeAccountRuntime>[0] = {
    paths,
    host: 'opencode',
    local: { refreshToken, now: () => clock },
    vault: {
      env,
      connect,
      readToken,
      now: () => clock,
      setTimeout: timers?.setTimeout,
      clearTimeout: timers?.clearTimeout,
    },
  }
  let runtime = createNativeAccountRuntime(options)
  cleanup.push(() => runtime.close())
  const markHost = async () => {
    await runtime.close()
    hostAuthority.resetVaultHostAuthorityForTests?.()
    env.CORTEXKIT_VAULT_HOST = 'thalamus'
    const accessor = host(relay)
    runtime = createNativeAccountRuntime(options)
    return accessor
  }
  const restartNative = async () => {
    await runtime.close()
    delete process.env.CORTEXKIT_VAULT_HOST
    delete env.CORTEXKIT_VAULT_HOST
    hostAuthority.resetVaultHostAuthorityForTests?.()
    runtime = createNativeAccountRuntime(options)
  }
  return {
    root,
    paths,
    env,
    native,
    relay,
    get runtime() {
      return runtime
    },
    connect,
    readToken,
    refreshToken,
    before,
    bytes,
    markHost,
    restartNative,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

for (const refused of [false, true]) {
  test(`hosted Insula ${refused ? 'refusal polling' : 'held-open watch'} keeps admission fresh and closes on authority change`, async () => {
    const background = insulaBackground(refused)
    const f = await fixture(background)
    let readingAt = now - 30_000
    const transport = f.relay.insula!
    transport.watchUsage = background.watchUsage
    transport.getUsage = mock(async () => ({
      completeProviders: ['claude'],
      result: [
        {
          provider: 'claude',
          account: accountId,
          fetchedAt: new Date(readingAt).toISOString(),
          source: 'vault',
          usage: {
            primary: {
              usedPercent: 40,
              windowKind: 'five_hour',
              windowMinutes: 300,
            },
            secondary: {
              usedPercent: 55,
              windowKind: 'weekly',
              windowMinutes: 10_080,
            },
          },
        },
      ],
    }))
    await f.markHost()
    await f.runtime.vault.refresh()
    const direct = Object.assign(
      mock(async () =>
        Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      ),
      { preconnect: fetch.preconnect },
    )
    await f.runtime.vault.fetchQuota(
      'main',
      direct,
      undefined,
      undefined,
      'background',
    )
    const lease = claustrum.acquireInsulaQuotaSource(
      transport,
      `${getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath}.host-anthropic-auth`,
    )
    cleanup.push(lease.release)
    if (refused) {
      for (let minute = 1; minute <= 4; minute++) {
        f.advance(60_000)
        readingAt = now + minute * 60_000 - 30_000
        await background.tick()
      }
      f.advance(30_000)
      expect(transport.getUsage).toHaveBeenCalledTimes(5)
    } else {
      f.advance(180_000)
      readingAt = now + 150_000
      background.notice()
      expect(lease.source.watchMode()).toBe('watching')
      await lease.source.refresh(now + 180_000)
      f.advance(60_000)
      const reads = (transport.getUsage as ReturnType<typeof mock>).mock.calls
        .length
      await background.tick()
      expect(transport.getUsage).toHaveBeenCalledTimes(reads)
      f.advance(30_000)
    }
    const quota = await f.runtime.vault.fetchQuota(
      'main',
      direct,
      undefined,
      undefined,
      'admission',
    )
    expect(quota.five_hour?.checkedAt).toBe(readingAt)
    expect(direct).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.readToken).not.toHaveBeenCalled()
    expect(background.counts.opens).toBe(1)
    delete process.env.CORTEXKIT_VAULT_HOST
    expect(() => isVaultHosted()).toThrow()
    expect(background.timers.size).toBe(0)
    if (!refused) expect(background.counts.stops).toBe(1)
  })
}

test('unmarked accessor is never called and native custody keeps reading enrollment', async () => {
  const owned = client()
  const accessor = mock(() => owned)
  globals[symbol] = accessor
  const readToken = mock(async () => ({
    token: '01'.repeat(32),
    token_generation: 1,
  }))
  const custody = createNativeCustody({
    host: 'opencode',
    connect: async () => owned,
    readToken,
    now: () => now,
  })
  cleanup.push(() => custody.close())
  await custody.discover()
  await custody.authorize({ credentialId, accountIdentity: accountId })
  expect(readToken).toHaveBeenCalledTimes(2)
  expect(accessor).not.toHaveBeenCalled()
  expect(
    await readNativeEnrollmentMode('opencode', {
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE:
        '/nonexistent/native-vault-host-enrollment',
    }),
  ).toBe('local')
})

for (const failure of ['absent', 'throws'] as const) {
  test(`host ${failure} accessor refuses without local or enrollment activity; late bridge recovers`, async () => {
    const f = await fixture()
    await f.markHost()
    if (failure === 'absent') delete globals[symbol]
    else
      globals[symbol] = () => {
        throw new Error('private host failure')
      }
    const tokenRead = mock(async () => {
      throw new Error('token read forbidden')
    })
    expect(
      await readNativeEnrollmentMode('opencode', f.env, {
        enrollmentAuthority: claustrum.vaultAuthority,
        readClaustrumEnrollmentStatus: tokenRead,
      }),
    ).toBe('claustrum')
    await expect(f.runtime.vault.refresh()).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(await f.runtime.authorizeLocal('main')).toEqual({
      status: 'refused',
      reason: 'custody-mode',
      persisted: false,
    })
    await expect(
      f.runtime.addApi({ apiKey: 'synthetic-key' }),
    ).rejects.toBeDefined()
    await expect(
      f.runtime.loginOAuth({
        routeId: 'main',
        credential: { access: 'synthetic', refresh: 'synthetic', expires: 1 },
      }),
    ).rejects.toBeDefined()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.readToken).not.toHaveBeenCalled()
    expect(tokenRead).not.toHaveBeenCalled()
    expect(f.refreshToken).not.toHaveBeenCalled()
    expect(await f.bytes()).toEqual(f.before)
    const accessor = host(f.relay)
    await f.runtime.vault.refresh()
    const snapshot = await f.runtime.read()
    const route = snapshot.accounts[0]?.id
    expect(route).toBeDefined()
    expect((await f.runtime.authorizeVault(route!)).accessToken).toBe(
      'synthetic-host-bearer',
    )
    expect(accessor).toHaveBeenCalledTimes(1)
    expect(f.readToken).not.toHaveBeenCalled()
    expect(await f.bytes()).toEqual(f.before)
  })
}

test('host custody accepts only the real branded connection and shares its Insula transport', async () => {
  const owned = client()
  const accessor = host(owned)
  const custody = createNativeCustody({
    host: 'opencode',
    connect: async () => {
      throw new Error('native connector forbidden')
    },
    readToken: async () => {
      throw new Error('token read forbidden')
    },
    now: () => now,
  })
  cleanup.push(() => custody.close())
  await custody.discover()
  const receipt = await custody.authorize({
    credentialId,
    accountIdentity: accountId,
  })
  await custody.reportFailure(receipt, 401, 'direct')
  const transport = await custody.insulaTransport()
  await transport?.getUsage()
  expect(accessor).toHaveBeenCalledTimes(1)
  expect(owned.listScoped).toHaveBeenCalledWith('')
  expect(owned.getScoped).toHaveBeenCalledWith(
    expect.objectContaining({ enrollmentToken: '' }),
  )
  expect(owned.insula?.getUsage).toHaveBeenCalledTimes(1)
  expect(owned.reportAuthFailureScoped).toHaveBeenCalledTimes(1)
  expect(receipt.assertedAccountIdentity).toBe(accountId)
})

test('restarting with new authority releases old Insula sources and isolates matching connection files', async () => {
  const f = await fixture()
  const tokenPath = getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await f.runtime.vault.refresh()
  const route = (await f.runtime.read()).accounts[0]!.id
  const usage: typeof fetch = Object.assign(
    async () =>
      Response.json({
        five_hour: { utilization: 10 },
        seven_day: { utilization: 10 },
      }),
    { preconnect: fetch.preconnect },
  )
  const warm = async () => {
    await f.runtime
      .fetchQuota(route, usage, undefined, undefined, 'background')
      .catch(() => {})
  }
  await warm()
  expect(f.native.insula?.getUsage).toHaveBeenCalledTimes(1)
  const nativeLease = claustrum.acquireInsulaQuotaSource(
    f.native.insula!,
    tokenPath,
  )
  const oldNativeSource = nativeLease.source
  nativeLease.release()
  await f.markHost()
  // A malformed enrollment file proves hosted Insula cannot be reading it.
  await writeFile(tokenPath, 'not an enrollment token', { mode: 0o600 })
  await f.runtime.vault.refresh()
  await warm()
  expect(f.relay.insula?.getUsage).toHaveBeenCalledTimes(1)
  const hostLease = claustrum.acquireInsulaQuotaSource(
    f.relay.insula!,
    `${tokenPath}.host-anthropic-auth`,
  )
  const hostSource = hostLease.source
  expect(hostSource).not.toBe(oldNativeSource)
  hostLease.release()
  const replacementNative = claustrum.acquireInsulaQuotaSource(
    f.native.insula!,
    tokenPath,
  )
  expect(replacementNative.source).not.toBe(oldNativeSource)
  replacementNative.release()
  await f.restartNative()
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await f.runtime.vault.refresh()
  const replacementHost = claustrum.acquireInsulaQuotaSource(
    f.relay.insula!,
    `${tokenPath}.host-anthropic-auth`,
  )
  expect(replacementHost.source).not.toBe(hostSource)
  replacementHost.release()
  expect(f.relay.close).toHaveBeenCalledTimes(1)
  expect(await f.bytes()).toEqual(f.before)
})

for (const hostName of ['opencode', 'pi'] as const) {
  test(`${hostName} hosted menu status and stale connect/disconnect dispatch are refused`, async () => {
    host(client())
    const dispatch = mock(async () => ({ ok: true, text: 'done' }))
    const disconnect = mock(async () => 'idle' as const)
    const menu = createNativeUi({
      host: hostName,
      readMode: async () => 'local',
      readStatus: async () => 'account status',
      dispatch,
      disconnectVault: disconnect,
      interactive: true,
    })
    const invocation = { sessionId: 'host-session', notify() {} }
    const opened = await menu.open(invocation)
    const accounts = opened.menu.sections.find(
      (section) => section.id === 'Accounts',
    )!
    expect(accounts.lines).toContain(claustrum.VAULT_HOST_STATUS)
    expect(
      accounts.actions?.some((action) =>
        ['vault-disconnect', 'custody-mode', 'add-oauth-start'].includes(
          action.id,
        ),
      ),
    ).toBe(false)
    expect(accounts.actions?.some((action) => action.id === 'enable')).toBe(
      true,
    )
    for (const actionId of ['vault-disconnect', 'custody-mode']) {
      const result = await menu.apply(
        {
          command: 'claude',
          sectionId: 'Accounts',
          actionId,
          sessionId: 'host-session',
          values: actionId === 'custody-mode' ? { mode: 'claustrum' } : {},
          confirmed: true,
        },
        invocation,
      )
      expect(result.ok).toBe(false)
      expect(result.text).toBe(claustrum.VAULT_HOST_CONNECT_REFUSAL)
    }
    const executor = createNativeMenuExecutor({
      host: hostName,
      dispatch,
      disconnectVault: disconnect,
    })
    expect(
      (
        await executor.execute(
          { action: 'vault-disconnect', values: {} },
          { interactive: true, custodyMode: 'claustrum', confirmed: true },
        )
      ).status,
    ).toBe('refused')
    await expect(
      disconnectNativeVaultForHost({ host: 'opencode' }),
    ).rejects.toThrow(claustrum.VAULT_HOST_CONNECT_REFUSAL)
    expect(dispatch).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })
}

test('a pinned session and credential caches survive shared enrollment switching to hosted authority', async () => {
  const f = await fixture()
  const tokenPath = getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await f.runtime.vault.refresh()
  const before = await f.runtime.read()
  const account = before.accounts[0]!
  const receipt = await f.runtime.authorizeVault(account.id)
  const lineage = await f.runtime.getOrCreateAuthLineage(account.id, receipt)
  expect(lineage).toBeDefined()
  const vaultPaths = nativeVaultPaths(f.paths)
  expect(before.routingPath).toBe(vaultPaths.routing)
  const router = new StickySessionRouter({
    path: before.routingPath!,
    now: () => now,
  })
  cleanup.push(() => router.drain())
  const resolvePin = async () => {
    const snapshot = await f.runtime.read()
    const result = await router.resolve({
      sessionId: 'already-pinned',
      family: 'general',
      modelId: 'claude-sonnet-4-6',
      candidates: snapshot.accounts.map((entry) => ({
        accountId: entry.id,
        order: 0,
        quota: { kind: 'unknown' as const },
      })),
      retainAccountIds: new Set(snapshot.accounts.map((entry) => entry.id)),
      accountIdentities: new Map(
        snapshot.accounts.map((entry) => [entry.id, entry.accountIdentity!]),
      ),
      storage: null,
      inputBytes: 77,
    })
    await router.drain()
    return result
  }
  const pinned = await resolvePin()
  expect(pinned?.created).toBe(true)
  const settings = await readFile(vaultPaths.config)
  await f.markHost()
  await f.runtime.vault.refresh()
  const after = await f.runtime.read()
  expect(after.routingPath).toBe(before.routingPath)
  expect(
    after.accounts.map((entry) => [entry.id, entry.accountIdentity]),
  ).toEqual(before.accounts.map((entry) => [entry.id, entry.accountIdentity]))
  const kept = await resolvePin()
  expect(kept?.accountId).toBe(pinned?.accountId)
  expect(kept?.created).toBe(false)
  expect(kept?.migrated).toBe(false)
  expect(kept?.assignment.assignedAt).toBe(pinned?.assignment.assignedAt)
  const hostedReceipt = await f.runtime.authorizeVault(account.id)
  expect(
    await f.runtime.getOrCreateAuthLineage(account.id, hostedReceipt),
  ).toBe(lineage)
  expect(await readFile(vaultPaths.config)).toEqual(settings)
  expect(await f.bytes()).toEqual(f.before)
})

test('only the Core hosted helper reads the marker in production sources', async () => {
  const stray: string[] = []
  let checked = 0
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'tests' || entry.name === 'dist') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        entry.name !== 'native-vault-host.ts'
      ) {
        checked++
        const source = (await readFile(path, 'utf8')).replace(
          /delete\s+[\w.]+\.CORTEXKIT_VAULT_HOST\b/g,
          '',
        )
        if (source.includes('CORTEXKIT_VAULT_HOST')) stray.push(path)
      }
    }
  }
  for (const relative of ['../', '../../../opencode/src/', '../../../pi/src/'])
    await scan(fileURLToPath(new URL(relative, import.meta.url)))
  expect(checked).toBeGreaterThan(100)
  expect(stray).toEqual([])
  delete process.env.CORTEXKIT_VAULT_HOST
  expect(isVaultHosted()).toBe(false)
  process.env.CORTEXKIT_VAULT_HOST = 'other'
  expect(isVaultHosted()).toBe(false)
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  hostAuthority.resetVaultHostAuthorityForTests?.()
  expect(isVaultHosted()).toBe(true)
})

function gate() {
  let open = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

function holdRead(path: string, ordinal = 1) {
  const entered = gate()
  const release = gate()
  const original = claustrum.readVaultRoster
  let reads = 0
  let armed = false
  const replacement = (async (...args: Parameters<typeof original>) => {
    const value = await original(...args)
    if (armed && String(args[0]) === path && ++reads === ordinal) {
      entered.open()
      await release.wait
    }
    return value
  }) as typeof original
  const spy = spyOn(claustrum, 'readVaultRoster').mockImplementation(
    replacement,
  )
  const finish = () => {
    release.open()
    spy.mockRestore()
  }
  cleanup.push(finish)
  return {
    entered: entered.wait,
    arm: () => {
      armed = true
    },
    release: finish,
  }
}

async function enrolled(f: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(
    getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await f.runtime.vault.refresh()
}

function flip(hosted: boolean) {
  if (hosted) process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  else delete process.env.CORTEXKIT_VAULT_HOST
}

for (const initiallyHosted of [false, true]) {
  test(`authority is permanently refused after ${initiallyHosted ? 'host-to-native' : 'native-to-host'} marker change and warns once`, async () => {
    flip(initiallyHosted)
    expect(isVaultHosted()).toBe(initiallyHosted)
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const custody = hostCustody()
    cleanup.push(() => warn.mockRestore())
    flip(!initiallyHosted)
    expect(() => isVaultHosted()).toThrow('route-unavailable')
    await expect(custody.discover()).rejects.toMatchObject({
      code: 'route-unavailable',
    })
    flip(initiallyHosted)
    expect(() => isVaultHosted()).toThrow('route-unavailable')
    expect(() => isVaultHosted()).toThrow('route-unavailable')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'claustrum',
      'Vault host authority changed; restart required',
    )
  })

  test(`vault receipt held at its final roster read refuses a ${initiallyHosted ? 'host-to-native' : 'native-to-host'} change`, async () => {
    const f = await fixture()
    if (initiallyHosted) {
      await f.markHost()
      await f.runtime.vault.refresh()
    } else await enrolled(f)
    const route = (await f.runtime.read()).accounts[0]!.id
    const held = holdRead(nativeVaultPaths(f.paths).roster)
    const backend = initiallyHosted ? f.relay : f.native
    const get = backend.getScoped
    backend.getScoped = async (input) => {
      const value = await get(input)
      held.arm()
      return value
    }
    const pending = f.runtime.vault.authorize(route)
    const settled = Promise.allSettled([pending])
    try {
      await Promise.race([
        held.entered,
        pending.then(() => {
          throw new Error('receipt returned before barrier')
        }),
      ])
      flip(!initiallyHosted)
    } finally {
      held.release()
    }
    const [result] = await settled
    expect(result).toMatchObject({
      status: 'rejected',
      reason: { code: 'route-unavailable' },
    })
    flip(initiallyHosted)
    await expect(f.runtime.read()).rejects.toMatchObject({
      code: 'route-unavailable',
    })
    expect(await f.bytes()).toEqual(f.before)
  })

  test(`receipt publication held at its final roster read refuses a ${initiallyHosted ? 'host-to-native' : 'native-to-host'} change`, async () => {
    const f = await fixture()
    if (initiallyHosted) {
      await f.markHost()
      await f.runtime.vault.refresh()
    } else await enrolled(f)
    const route = (await f.runtime.read()).accounts[0]!.id
    const receipt = await f.runtime.vault.authorize(route)
    const path = nativeVaultPaths(f.paths).runtime
    const before = await readFile(path).catch(() => null)
    const held = holdRead(nativeVaultPaths(f.paths).roster, 2)
    held.arm()
    const pending = f.runtime.vault.publish(receipt, { lastUsed: now })
    const settled = Promise.allSettled([pending])
    try {
      await Promise.race([
        held.entered,
        pending.then(() => {
          throw new Error('published before barrier')
        }),
      ])
      flip(!initiallyHosted)
    } finally {
      held.release()
    }
    expect((await settled)[0].status).toBe('rejected')
    expect(await readFile(path).catch(() => null)).toEqual(before)
    expect(await f.bytes()).toEqual(f.before)
  })
}

test('unmarked runtime storage key is byte-identical to the enrolled/local key', async () => {
  const f = await fixture()
  const enrollment = getHostClaustrumEnrollmentPaths('opencode', f.env)
  const expected = JSON.stringify([
    'opencode',
    f.paths.storageId,
    ...(
      [
        'legacyConfig',
        'legacyState',
        'config',
        'state',
        'runtime',
        'journal',
        'roster',
      ] as const
    ).map((key) => resolve(f.paths[key])),
    resolve(enrollment.tokenPath),
    resolve(enrollment.statePath),
    resolve(nativeRuntimeConnectionFile('opencode', f.env)),
  ])
  expect(
    nativeRuntimeStorageKey({ paths: f.paths, host: 'opencode', env: f.env }),
  ).toBe(expected)
})

function manualTimers() {
  type Timer = {
    milliseconds: number
    run(): void
    cleared: boolean
    unref(): void
  }
  const timers: Timer[] = []
  return {
    setTimeout: ((run: () => void, milliseconds: number) => {
      const timer: Timer = { milliseconds, run, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: Timer) => {
      timer.cleared = true
    }) as unknown as typeof clearTimeout,
    pending: () =>
      timers
        .filter((timer) => !timer.cleared)
        .map((timer) => timer.milliseconds),
    run(milliseconds: number) {
      const timer = timers.find(
        (timer) => !timer.cleared && timer.milliseconds === milliseconds,
      )
      expect(timer).toBeDefined()
      timer!.cleared = true
      timer!.run()
    },
  }
}

function outageClient() {
  const owned = client()
  const list = owned.listScoped
  const get = owned.getScoped
  let outage = false
  owned.listScoped = async (...args) => {
    if (outage) throw new claustrum.ClaustrumUnreachableError()
    return list(...args)
  }
  owned.getScoped = async (...args) => {
    if (outage) throw new claustrum.ClaustrumUnreachableError()
    return get(...args)
  }
  return {
    owned,
    fail: () => {
      outage = true
    },
    recover: () => {
      outage = false
    },
  }
}

function hostCustody(
  timers: Pick<
    NativeCustodyOptions,
    'setTimeout' | 'clearTimeout'
  > = manualTimers(),
) {
  const custody = createNativeCustody({
    host: 'opencode',
    now: () => now,
    ...timers,
    connect: async () => {
      throw new Error('native connector forbidden')
    },
  })
  cleanup.push(() => custody.close())
  return custody
}

const identity = { credentialId, accountIdentity: accountId }

test('an outage serves kept receipts and a proven same-authority reconnect preserves receipts', async () => {
  const timers = manualTimers()
  const old = outageClient()
  const oldClosed = gate()
  old.owned.close = mock(() => oldClosed.open())
  const fresh = client()
  fresh.getScoped = mock(async () => ({
    credentialId,
    accountId,
    material: 'synthetic-reconnected-bearer',
    recordVersion: 8,
    expiresAtMs: now + 3_600_000,
  }))
  const accessor = host((index) => (index === 0 ? old.owned : fresh))
  const custody = hostCustody(timers)
  const first = await custody.authorize(identity)
  old.fail()
  expect((await custody.authorize(identity)).fromKeptReceipt).toBe(true)
  expect(accessor).toHaveBeenCalledTimes(1)
  timers.run(0)
  await oldClosed.wait
  expect(accessor).toHaveBeenCalledTimes(2)
  expect(accessor.closed).toEqual([0])
  expect((await custody.authorize(identity)).accessToken).toBe(
    'synthetic-reconnected-bearer',
  )
  await custody.reportFailure(first, 401, 'direct')
  expect(old.owned.reportAuthFailureScoped).not.toHaveBeenCalled()
  expect(fresh.reportAuthFailureScoped).toHaveBeenCalledTimes(1)
  expect(fresh.reportAuthFailureScoped).toHaveBeenCalledWith(
    expect.objectContaining({
      recordVersion: first.recordVersion,
      providerStatus: 401,
    }),
  )
  custody.close()
  expect(accessor.closed).toEqual([0, 1])
})

test('client replacement keeps the serving receipt until and after the candidate proves a roster read', async () => {
  const timers = manualTimers()
  const old = outageClient()
  const fresh = outageClient()
  const entered = gate(),
    release = gate(),
    swapped = gate()
  old.owned.close = mock(swapped.open)
  const list = fresh.owned.listScoped
  fresh.owned.listScoped = mock(async (...args) => {
    entered.open()
    await release.wait
    return list(...args)
  })
  cleanup.push(release.open)
  const accessor = host((index) => (index === 0 ? old.owned : fresh.owned))
  const custody = hostCustody(timers)
  const served = await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  timers.run(0)
  await entered.wait
  expect(accessor.closed).toEqual([])
  const pendingReceipt = await custody.authorize(identity)
  expect(pendingReceipt.fromKeptReceipt).toBe(true)
  expect(pendingReceipt.accessToken).toBe(served.accessToken)
  release.open()
  await swapped.wait
  expect(custody.generation).toBe(0)
  fresh.fail()
  const kept = await custody.authorize(identity)
  expect(kept.fromKeptReceipt).toBe(true)
  expect(kept.accessToken).toBe(served.accessToken)
  expect((await custody.prepareRetry(kept)).retry).toBe(false)
  expect(fresh.owned.reportAuthFailureScoped).not.toHaveBeenCalled()
  custody.close()
  expect(accessor.closed).toEqual([0, 1])
})

test('a failing relay proof closes its probe and keeps serving the old primitive until the bounded retry succeeds', async () => {
  const timers = manualTimers()
  const old = outageClient()
  const failed = client()
  const probeClosed = gate()
  failed.listScoped = mock(async () => {
    throw new claustrum.ClaustrumUnreachableError()
  })
  failed.close = mock(() => probeClosed.open())
  const healthy = client()
  const oldClosed = gate()
  old.owned.close = mock(() => oldClosed.open())
  const accessor = host((index) =>
    index === 0 ? old.owned : index === 1 ? failed : healthy,
  )
  const custody = hostCustody(timers)
  await custody.authorize(identity)
  old.fail()
  expect((await custody.authorize(identity)).fromKeptReceipt).toBe(true)
  timers.run(0)
  await probeClosed.wait
  expect(accessor.closed).toEqual([1])
  expect((await custody.authorize(identity)).fromKeptReceipt).toBe(true)
  expect(accessor).toHaveBeenCalledTimes(2)
  timers.run(1_000)
  await oldClosed.wait
  expect(accessor.closed).toEqual([1, 0])
  expect((await custody.authorize(identity)).fromKeptReceipt).not.toBe(true)
})

test('close during a relay proof cancels it and closes each serving and probe client once', async () => {
  const timers = manualTimers()
  const old = outageClient()
  const entered = gate()
  const release = gate()
  const pending = client()
  pending.listScoped = mock(async () => {
    entered.open()
    await release.wait
    return client().listScoped('')
  })
  const accessor = host((index) => (index === 0 ? old.owned : pending))
  const custody = hostCustody(timers)
  await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  timers.run(0)
  try {
    await entered.wait
    custody.close()
    expect(accessor.closed.toSorted()).toEqual([0, 1])
  } finally {
    release.open()
  }
  await expect(custody.authorize(identity)).rejects.toMatchObject({
    code: 'closed',
  })
})

test('a receipt issued before a proven relay replacement can still publish afterward', async () => {
  const timers = manualTimers()
  const f = await fixture(timers)
  await f.markHost()
  const old = outageClient()
  const oldClosed = gate()
  old.owned.close = mock(() => oldClosed.open())
  host((index) => (index === 0 ? old.owned : client()))
  await f.runtime.vault.refresh()
  const route = (await f.runtime.read()).accounts[0]!.id
  const first = await f.runtime.vault.authorize(route)
  old.fail()
  expect((await f.runtime.vault.authorize(route)).fromKeptReceipt).toBe(true)
  timers.run(0)
  await oldClosed.wait
  expect(await f.runtime.vault.publish(first, { lastUsed: now })).toBe(true)
  const current = await f.runtime.vault.authorize(route)
  expect(await f.runtime.vault.publish(current, { lastUsed: now })).toBe(true)
})

test('primary pin publication refuses a host change during its last roster read', async () => {
  const f = await fixture()
  await f.markHost()
  await f.runtime.vault.refresh()
  const paths = nativeVaultPaths(f.paths)
  await rm(paths.config)
  const held = holdRead(paths.roster, 2)
  held.arm()
  const pending = f.runtime.vault.initializeSettings()
  const settled = Promise.allSettled([pending])
  try {
    await Promise.race([
      held.entered,
      pending.then(() => {
        throw new Error('pin published before barrier')
      }),
    ])
    flip(false)
  } finally {
    held.release()
  }
  expect((await settled)[0].status).toBe('rejected')
  await expect(readFile(paths.config)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.bytes()).toEqual(f.before)
})

test('a cached native Insula source is not used after the marker changes during its token read', async () => {
  const f = await fixture()
  await enrolled(f)
  const first = f.runtime.vault.watch({ intervalMs: 0 })
  await first.ready
  first.close()
  expect(f.native.insula?.getUsage).toHaveBeenCalledTimes(1)
  f.advance(61_001)
  const entered = gate()
  const release = gate()
  const original = claustrum.readClaustrumEnrollmentToken
  const spy = spyOn(
    claustrum,
    'readClaustrumEnrollmentToken',
  ).mockImplementation(async (...args) => {
    const token = await original(...args)
    entered.open()
    await release.wait
    return token
  })
  cleanup.push(() => {
    release.open()
    spy.mockRestore()
  })
  const next = f.runtime.vault.watch({ intervalMs: 0 })
  cleanup.push(() => next.close())
  const settled = Promise.allSettled([next.ready])
  try {
    await Promise.race([
      entered.wait,
      next.ready.then(() => {
        throw new Error('Insula refreshed before barrier')
      }),
    ])
    flip(true)
  } finally {
    release.open()
  }
  await settled
  expect(f.native.insula?.getUsage).toHaveBeenCalledTimes(1)
  await expect(f.runtime.read()).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  const nextTransport = client().insula!
  const nextSource = claustrum.acquireInsulaQuotaSource(
    nextTransport,
    getHostClaustrumEnrollmentPaths('opencode', f.env).tokenPath,
  )
  cleanup.push(() => nextSource.release())
  await nextSource.source.refresh(now + 61_001)
  expect(nextTransport.getUsage).toHaveBeenCalledTimes(1)
  expect(f.native.insula?.getUsage).toHaveBeenCalledTimes(1)
  expect(await f.bytes()).toEqual(f.before)
})

test('an Insula transport whose getter changes authority is discarded before source installation', async () => {
  const f = await fixture()
  await enrolled(f)
  const transport = f.native.insula!
  Object.defineProperty(f.native, 'insula', {
    get() {
      flip(true)
      return transport
    },
  })
  const watch = f.runtime.vault.watch({ intervalMs: 0 })
  cleanup.push(() => watch.close())
  await watch.ready
  expect(transport.getUsage).not.toHaveBeenCalled()
  await expect(f.runtime.read()).rejects.toMatchObject({
    code: 'route-unavailable',
  })
  expect(await f.bytes()).toEqual(f.before)
})

async function swappingRuntime() {
  const timers = manualTimers()
  const f = await fixture(timers)
  await f.markHost()
  const old = outageClient()
  const closed = gate()
  old.owned.close = mock(closed.open)
  const fresh = client()
  const accessor = host((index) => (index === 0 ? old.owned : fresh))
  await f.runtime.vault.refresh()
  const route = (await f.runtime.read()).accounts[0]!.id
  const swap = async () => {
    old.fail()
    await f.runtime.vault.authorize(route)
    timers.run(0)
    await closed.wait
  }
  return { ...f, old, fresh, route, swap, accessor }
}

test('a pre-swap 401 is reported through the replacement client without a same-version request retry', async () => {
  const f = await swappingRuntime()
  const served = await f.runtime.vault.authorize(f.route)
  await f.swap()
  await f.runtime.vault.reportFailure(served, 401, 'direct')
  expect(f.old.owned.reportAuthFailureScoped).not.toHaveBeenCalled()
  await f.runtime.vault.reportFailure(served, 401, 'direct')
  expect(f.fresh.reportAuthFailureScoped).toHaveBeenCalledTimes(1)
  const retry = await f.runtime.vault.prepareRetry(served)
  expect(retry).toEqual({ retry: false, reason: 'version-not-newer' })
  expect(f.fresh.getScoped).toHaveBeenCalledTimes(1)
  expect(f.fresh.reportAuthFailureScoped).toHaveBeenCalledWith(
    expect.objectContaining({ recordVersion: 7, providerStatus: 401 }),
  )
  expect((await f.runtime.vault.prepareRetry(served)).retry).toBe(false)
})

test('a pre-swap 401 still permits one strict-newer-version retry through the replacement client', async () => {
  const f = await swappingRuntime()
  const served = await f.runtime.vault.authorize(f.route)
  const get = f.fresh.getScoped
  f.fresh.getScoped = mock(async (...args: Parameters<typeof get>) => ({
    ...(await get(...args)),
    recordVersion: 8,
  }))
  await f.swap()
  await f.runtime.vault.reportFailure(served, 401, 'direct')
  const retry = await f.runtime.vault.prepareRetry(served)
  expect(retry.retry).toBe(true)
  if (!retry.retry) throw new Error('Rotated credential retry refused')
  expect(retry.receipt.recordVersion).toBe(8)
  await f.runtime.vault.reportFailure(retry.receipt, 401, 'direct')
  expect(f.old.owned.reportAuthFailureScoped).not.toHaveBeenCalled()
  expect(f.fresh.reportAuthFailureScoped).toHaveBeenCalledTimes(2)
  expect((await f.runtime.vault.prepareRetry(retry.receipt)).retry).toBe(false)
  expect((await f.runtime.vault.prepareRetry(served)).retry).toBe(false)
})

test('a successful pre-swap dispatch needs no replacement authorization or report', async () => {
  const f = await swappingRuntime()
  const receipt = await f.runtime.vault.authorize(f.route)
  await f.swap()
  expect(await f.runtime.vault.publish(receipt, { lastUsed: now })).toBe(true)
  expect(f.fresh.getScoped).not.toHaveBeenCalled()
  expect(f.fresh.reportAuthFailureScoped).not.toHaveBeenCalled()
})

test('Core prepareRetry keeps a receipt usable when a relay swap occurs after authorize returns', async () => {
  const f = await swappingRuntime()
  const first = await f.runtime.vault.authorize(f.route)
  const get = f.old.owned.getScoped
  f.old.owned.getScoped = mock(async (...args: Parameters<typeof get>) => ({
    ...(await get(...args)),
    recordVersion: 8,
  }))
  const held = holdRead(nativeVaultPaths(f.paths).roster, 2)
  held.arm()
  const pending = f.runtime.vault.prepareRetry(first)
  const settled = Promise.allSettled([pending])
  await held.entered
  await f.swap()
  held.release()
  try {
    expect((await pending).retry).toBe(true)
  } finally {
    await settled
  }
})

test('Core quota dispatch can send a pre-swap receipt and a later 401 is reauthorized normally', async () => {
  const f = await swappingRuntime()
  const get = f.fresh.getScoped
  f.fresh.getScoped = mock(async (...args: Parameters<typeof get>) => ({
    ...(await get(...args)),
    recordVersion: 8,
  }))
  const entered = gate(),
    release = gate()
  let sends = 0
  const fetcher = Object.assign(
    mock(async () =>
      ++sends === 1
        ? new Response('', { status: 401 })
        : Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
          }),
    ),
    { preconnect: fetch.preconnect },
  )
  const pending = f.runtime.vault.fetchQuota(
    f.route,
    fetcher,
    undefined,
    async (send, admit) => {
      await admit()
      if (sends === 0) {
        entered.open()
        await release.wait
      }
      return send()
    },
  )
  const settled = Promise.allSettled([pending])
  cleanup.push(release.open)
  await entered.wait
  await f.swap()
  release.open()
  try {
    await pending
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(f.fresh.getScoped).toHaveBeenCalledTimes(1)
    expect(f.old.owned.reportAuthFailureScoped).not.toHaveBeenCalled()
    expect(f.fresh.reportAuthFailureScoped).not.toHaveBeenCalled()
  } finally {
    await settled
  }
})

test('a recovered serving relay wins over a pending proven replacement', async () => {
  const timers = manualTimers(),
    old = outageClient(),
    fresh = client()
  const entered = gate(),
    release = gate(),
    discarded = gate(),
    promoted = gate()
  old.owned.close = mock(promoted.open)
  const list = fresh.listScoped
  fresh.listScoped = mock(async (...args) => {
    entered.open()
    await release.wait
    return list(...args)
  })
  fresh.close = mock(discarded.open)
  const accessor = host((index) => (index === 0 ? old.owned : fresh))
  const custody = hostCustody(timers)
  await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  timers.run(0)
  await entered.wait
  old.recover()
  await custody.discover()
  release.open()
  await Promise.race([discarded.wait, promoted.wait])
  expect(accessor.closed).toEqual([1])
  expect(custody.generation).toBe(0)
  expect((await custody.authorize(identity)).accessToken).toBe(
    'synthetic-host-bearer',
  )
})

test('client replacement preserves retain changes made while its roster proof awaited', async () => {
  const timers = manualTimers(),
    old = outageClient(),
    fresh = outageClient()
  const entered = gate(),
    release = gate(),
    swapped = gate()
  old.owned.close = mock(swapped.open)
  const list = fresh.owned.listScoped
  fresh.owned.listScoped = mock(async (...args) => {
    entered.open()
    await release.wait
    return list(...args)
  })
  cleanup.push(() => {
    release.open()
  })
  host((index) => (index === 0 ? old.owned : fresh.owned))
  const custody = hostCustody(timers)
  custody.retain([{ ...identity, enabled: true, state: 'active' }])
  await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  timers.run(0)
  await entered.wait
  custody.retain([{ ...identity, enabled: false, state: 'active' }])
  release.open()
  await swapped.wait
  fresh.fail()
  await expect(custody.authorize(identity)).rejects.toMatchObject({
    code: 'unavailable',
  })
})

test('an answered probe refusal stops reconnect retries instead of treating it as a transport loss', async () => {
  const timers = manualTimers(),
    old = outageClient(),
    fresh = client()
  const discarded = gate()
  fresh.listScoped = mock(async () => {
    throw new Error('synthetic answered refusal')
  })
  fresh.close = mock(discarded.open)
  host((index) => (index === 0 ? old.owned : fresh))
  const custody = hostCustody(timers)
  await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  timers.run(0)
  await discarded.wait
  await Promise.resolve()
  expect(timers.pending()).not.toContain(1_000)
})

for (const platform of ['linux', 'win32'] as const) {
  test(`final ${platform} runtime rename refuses a flip during the post-beforeRename lease check`, async () => {
    const f = await fixture()
    await f.markHost()
    await f.runtime.vault.refresh()
    const route = (await f.runtime.read()).accounts[0]!.id
    const receipt = await f.runtime.vault.authorize(route)
    const vault = nativeVaultPaths(f.paths)
    await f.runtime.vault.publish(receipt, { lastUsed: now })
    const before = await readFile(vault.runtime)
    const entered = gate(),
      release = gate()
    let checks = 0,
      attempts = 0,
      held = false
    const update = runtimeWriter.updateNativeRuntimeOptional
    const writerSpy = spyOn(
      runtimeWriter,
      'updateNativeRuntimeOptional',
    ).mockImplementation((path, storageId, change, hooks) =>
      update(path, storageId, change, {
        ...hooks,
        beforeRename: async () => {
          const result = await hooks.beforeRename()
          checks++
          return result
        },
        publication: {
          platform,
          sleep: async () => {},
          rename: async (from, to) => {
            attempts++
            if (platform === 'win32' && attempts === 1)
              throw Object.assign(new Error('synthetic sharing refusal'), {
                code: 'EBUSY',
              })
            return rename(from, to)
          },
        },
      }),
    )
    type Lease = Parameters<Parameters<typeof locks.withLock>[2]>[0]
    const intercepted = new Proxy(locks.withLock, {
      apply(target, receiver, args) {
        if (args[0] !== vault.runtime)
          return Reflect.apply(target, receiver, args)
        const callback = args[2] as (lease: Lease) => unknown
        return Reflect.apply(target, receiver, [
          args[0],
          args[1],
          (lease: Lease) =>
            callback(
              new Proxy(lease, {
                get(target, key, receiver) {
                  if (key !== 'assertOwned')
                    return Reflect.get(target, key, receiver)
                  return async () => {
                    await target.assertOwned()
                    if (!held && checks === (platform === 'win32' ? 2 : 1)) {
                      held = true
                      entered.open()
                      await release.wait
                    }
                  }
                },
              }),
            ),
        ])
      },
    })
    const lockSpy = spyOn(locks, 'withLock').mockImplementation(intercepted)
    const pending = f.runtime.vault.publish(receipt, { lastUsed: now + 1 })
    const settled = Promise.allSettled([pending])
    cleanup.push(async () => {
      release.open()
      await settled
      writerSpy.mockRestore()
      lockSpy.mockRestore()
    })
    await Promise.race([
      entered.wait,
      pending.then(() => {
        throw new Error('rename passed the lease barrier')
      }),
    ])
    delete process.env.CORTEXKIT_VAULT_HOST
    release.open()
    expect((await settled)[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'publication-refused' },
    })
    expect(await readFile(vault.runtime)).toEqual(before)
    expect(attempts).toBe(platform === 'win32' ? 1 : 0)
  })
}

test('setEnabled refuses an authority flip inside the awaited roster-write callback before publication', async () => {
  const f = await fixture()
  await f.markHost()
  await f.runtime.vault.refresh()
  const route = (await f.runtime.read()).accounts[0]!.id
  await f.runtime.vault.setEnabled(route, false)
  const path = nativeVaultPaths(f.paths).roster
  const before = await readFile(path)
  const entered = gate(),
    release = gate()
  const mutate = claustrum.mutateVaultRoster
  const spy = spyOn(claustrum, 'mutateVaultRoster').mockImplementation(((
    target,
    change,
    options,
  ) =>
    mutate(
      target,
      async (current, context) => {
        const result = await change(current, context)
        entered.open()
        await release.wait
        return result
      },
      options,
    )) as typeof mutate)
  const pending = f.runtime.vault.setEnabled(route, true)
  const settled = Promise.allSettled([pending])
  cleanup.push(async () => {
    release.open()
    await settled
    spy.mockRestore()
  })
  await entered.wait
  delete process.env.CORTEXKIT_VAULT_HOST
  release.open()
  expect((await settled)[0]?.status).toBe('rejected')
  expect(await readFile(path)).toEqual(before)
})

test('setEnabled refuses success when custody closes during its final roster read', async () => {
  const f = await fixture()
  await f.markHost()
  await f.runtime.vault.refresh()
  const route = (await f.runtime.read()).accounts[0]!.id
  await f.runtime.vault.setEnabled(route, false)
  const held = holdRead(nativeVaultPaths(f.paths).roster, 2)
  held.arm()
  const pending = f.runtime.vault.setEnabled(route, true)
  const settled = Promise.allSettled([pending])
  cleanup.push(async () => {
    held.release()
    await settled
  })
  await held.entered
  f.runtime.vault.close()
  held.release()
  expect((await settled)[0]?.status).toBe('rejected')
})

for (const operation of ['authorize', 'discover'] as const) {
  test(`${operation} uses the replacement client after its ready await during a proven swap`, async () => {
    const timers = manualTimers(),
      old = outageClient(),
      fresh = client()
    fresh.getScoped = mock(async () => ({
      credentialId,
      accountId,
      material: 'synthetic-current-relay',
      recordVersion: 7,
      expiresAtMs: now + 3_600_000,
    }))
    host((index) => (index === 0 ? old.owned : fresh))
    const custody = hostCustody(timers)
    await custody.authorize(identity)
    old.fail()
    await custody.authorize(identity)
    const done = gate()
    let outcome: PromiseSettledResult<unknown> | undefined
    let armed = true
    const list = fresh.listScoped
    fresh.listScoped = mock((...args) =>
      list(...args).then((inventory) => {
        if (armed) {
          armed = false
          queueMicrotask(() => {
            const pending =
              operation === 'authorize'
                ? custody.authorize(identity)
                : custody.discover()
            void Promise.allSettled([pending]).then((results) => {
              outcome = results[0]
              done.open()
            })
          })
        }
        return inventory
      }),
    )
    timers.run(0)
    await done.wait
    expect(outcome?.status).toBe('fulfilled')
    if (operation === 'authorize')
      expect(outcome).toMatchObject({
        value: { accessToken: 'synthetic-current-relay' },
      })
    else expect(fresh.listScoped).toHaveBeenCalledTimes(2)
  })
}

test('closing custody swallows a dead primitive close failure exactly once', async () => {
  const owned = client()
  owned.close = mock(() => {
    throw new Error('synthetic dead relay close')
  })
  const accessor = host(owned)
  const custody = hostCustody()
  await custody.authorize(identity)
  expect(() => custody.close()).not.toThrow()
  expect(() => custody.close()).not.toThrow()
  expect(accessor.closed).toEqual([0])
})

test('custody run refuses an authority flip while a real scoped authorization completes', async () => {
  const owned = client(),
    entered = gate(),
    release = gate()
  const get = owned.getScoped
  owned.getScoped = mock(async (...args: Parameters<typeof get>) => {
    const receipt = await get(...args)
    entered.open()
    await release.wait
    return receipt
  })
  host(owned)
  const custody = hostCustody()
  const pending = custody.authorize(identity)
  const settled = Promise.allSettled([pending])
  cleanup.push(async () => {
    release.open()
    await settled
  })
  await entered.wait
  delete process.env.CORTEXKIT_VAULT_HOST
  release.open()
  expect((await settled)[0]).toMatchObject({
    status: 'rejected',
    reason: { code: 'route-unavailable' },
  })
})

test('prepareRetry refuses an authority flip after its awaited fresh authorization has completed', async () => {
  const f = await fixture()
  await f.markHost()
  const vault = createNativeVaultRuntime({
    paths: f.paths,
    host: 'opencode',
    now: () => now,
  })
  cleanup.push(() => vault.close())
  await vault.refresh()
  const route = (await vault.read())!.rows[0]!.routeId
  const first = await vault.authorize(route)
  const entered = gate(),
    release = gate()
  const authorize = vault.authorize.bind(vault)
  const spy = spyOn(vault, 'authorize').mockImplementation(async (...args) => {
    const receipt = await authorize(...args)
    entered.open()
    await release.wait
    return receipt
  })
  const pending = vault.prepareRetry(first)
  const settled = Promise.allSettled([pending])
  cleanup.push(async () => {
    release.open()
    await settled
    spy.mockRestore()
  })
  await entered.wait
  delete process.env.CORTEXKIT_VAULT_HOST
  release.open()
  expect((await settled)[0]).toMatchObject({
    status: 'rejected',
    reason: { code: 'route-unavailable' },
  })
})

test('a revoked probe safely closes a serving primitive whose client close throws', async () => {
  const timers = manualTimers(),
    old = outageClient(),
    fresh = client()
  const closed = gate()
  old.owned.close = mock(() => {
    closed.open()
    throw new Error('synthetic close failure')
  })
  fresh.listScoped = mock(async () => {
    throw new claustrum.ClaustrumCredentialError(
      'enrollment_revoked',
      'permanent',
      'gone',
    )
  })
  host((index) => (index === 0 ? old.owned : fresh))
  const custody = hostCustody(timers)
  await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  timers.run(0)
  await closed.wait
  await expect(custody.discover()).rejects.toMatchObject({ code: 'closed' })
  expect(timers.pending()).not.toContain(1_000)
})

test('hosted reconnect timers are unreferenced and custody close clears every live timer', async () => {
  const live = new Set<ReturnType<typeof setTimeout>>()
  const scheduled: Array<{
    delay: number
    timer: ReturnType<typeof setTimeout>
  }> = []
  const old = outageClient()
  const accessor = host(old.owned)
  const custody = hostCustody({
    setTimeout: ((callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        live.delete(timer)
        callback()
      }, 60_000)
      live.add(timer)
      scheduled.push({ delay, timer })
      return timer
    }) as typeof setTimeout,
    clearTimeout: ((timer: ReturnType<typeof setTimeout>) => {
      live.delete(timer)
      clearTimeout(timer)
    }) as typeof clearTimeout,
  })
  cleanup.push(() => {
    custody.close()
    for (const timer of live) clearTimeout(timer)
    live.clear()
  })
  await custody.authorize(identity)
  old.fail()
  await custody.authorize(identity)
  const reconnect = scheduled.find(({ delay }) => delay === 0)
  expect(reconnect).toBeDefined()
  expect(reconnect!.timer.hasRef()).toBe(false)
  custody.close()
  expect(live.size).toBe(0)
  expect(accessor.closed).toEqual([0])
})
