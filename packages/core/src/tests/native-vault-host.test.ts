import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as claustrum from '@cortexkit/common-auth/claustrum'
import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import {
  createNativeCustody,
  type NativeCustodyClient,
} from '../native-custody.ts'
import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { createNativeMenuExecutor } from '../native-menu-executor.ts'
import { createNativeUi } from '../native-ui.ts'
import { disconnectNativeVaultForHost } from '../native-vault-connection.ts'
import { isVaultHosted } from '../native-vault-host.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'

const symbol = Symbol.for('cortexkit.vault')
const globals = globalThis as unknown as Record<symbol, unknown>
const priorAccessor = globals[symbol]
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  delete process.env.CORTEXKIT_VAULT_HOST
  if (priorAccessor === undefined) delete globals[symbol]
  else globals[symbol] = priorAccessor
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
function host(owned: NativeCustodyClient) {
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  const accessor = mock((id: string) => {
    expect(id).toBe('anthropic-auth')
    return owned
  })
  globals[symbol] = accessor
  return accessor
}
async function fixture() {
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
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: { refreshToken },
    vault: { env, connect, readToken, now: () => now },
  })
  cleanup.push(() => runtime.close())
  const markHost = () => {
    env.CORTEXKIT_VAULT_HOST = 'thalamus'
    return host(relay)
  }
  return {
    root,
    paths,
    env,
    native,
    relay,
    runtime,
    connect,
    readToken,
    refreshToken,
    before,
    bytes,
    markHost,
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
    f.markHost()
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

test('switching authority releases old Insula sources and isolates matching connection files', async () => {
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
  f.markHost()
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
  delete process.env.CORTEXKIT_VAULT_HOST
  delete f.env.CORTEXKIT_VAULT_HOST
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
  f.markHost()
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
  expect(isVaultHosted()).toBe(true)
})
