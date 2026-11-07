import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as claustrum from '@cortexkit/common-auth/claustrum'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { logger } from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import {
  createNativeCustody,
  type NativeCustodyClient,
} from '../native-custody.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { createNativeMenuExecutor } from '../native-menu-executor.ts'
import {
  nativeRuntimeConnectionFile,
  nativeRuntimeStorageKey,
} from '../native-runtime-registry.ts'
import { createNativeUi } from '../native-ui.ts'
import { disconnectNativeVaultForHost } from '../native-vault-connection.ts'
import * as hostAuthority from '../native-vault-host.ts'
import { isVaultHosted } from '../native-vault-host.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
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
  }
}

function hostCustody(timers = manualTimers()) {
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

test('an outage serves kept receipts until a fresh relay proves reconnection, then retires old receipts', async () => {
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
  await expect(
    custody.reportFailure(first, 401, 'direct'),
  ).rejects.toMatchObject({ code: 'route-unavailable' })
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

test('a receipt issued before a proven relay replacement cannot publish afterward', async () => {
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
  await expect(
    f.runtime.vault.publish(first, { lastUsed: now }),
  ).rejects.toMatchObject({ code: 'route-unavailable' })
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
