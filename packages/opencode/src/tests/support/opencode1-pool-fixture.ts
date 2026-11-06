import { expect, mock } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AccountStorage,
  NativeCustodyClient,
  NativeRefreshSubject,
  OAuthQuotaSnapshot,
  ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
  custodyTombstoneOAuth,
  isCustodyTombstoneOAuth,
  primeMarkerNamespaceDir,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../../core/src/native-quota-codec.ts'
import { writeLegacyAccountFiles } from '../../../../core/src/tests/legacy-account-fixture.ts'
import { AnthropicAuthPlugin } from '../../index'
import { migrateNativeOpencodeFixture } from '../native-fixture.ts'
import { getPluginTestHandles } from '../plugin-test-handles'
import { extractUrl } from '../test-fetch'
import { createMockClient, type TestPlugin } from './opencode1-client.ts'
import {
  getBodyLifetime,
  type MigratedPool,
  type Opencode1TestContext,
  type PluginRuntimeOverrides,
  type PoolLogin,
  untilStateOrTestEnd,
} from './opencode1-test-context.ts'

export type { NativeOpencodeFixture } from '../native-fixture.ts'
export type { MigratedPool, PluginRuntimeOverrides, PoolLogin }

/**
 * The pause between reads of state that no in-process event reports (shared
 * files, a test's log sink). It paces the reads; it is not a budget, since the
 * wait lasts until the state arrives or the test ends.
 */
export const STATE_READ_PAUSE_MS = 10

export function createFallbackStorage(
  overrides?: Partial<AccountStorage>,
): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 30,
    },
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
      failClosedOnUnknownQuota: true,
    },
    accounts: [
      {
        id: 'fallback-1',
        type: 'oauth',
        access: 'sk-ant-oat01-fallback-access',
        refresh: 'fallback-refresh',
        expires: Date.now() + 5 * 60 * 60 * 1000,
        quota: {
          five_hour: {
            usedPercent: 25,
            remainingPercent: 75,
            checkedAt: Date.now(),
          },
          seven_day: {
            usedPercent: 30,
            remainingPercent: 70,
            checkedAt: Date.now(),
          },
        },
      },
    ],
    ...overrides,
  }
}

/** Default Anthropic account UUID for the main OAuth credential in these fixtures. */
export const syntheticMainAccountUuid =
  '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid

/**
 * Record in a legacy store which Claude account the main login belongs to: a
 * main profile observed for that login's access token. Migration then gives
 * the pool's main login a known account, which the native runtime confirms
 * with bootstrap alone instead of first exchanging the refresh token.
 */
export function bindMainAccount(
  storage: AccountStorage,
  access = 'sk-ant-oat01-main-access',
  identity: ProviderAccountUuid = syntheticMainAccountUuid,
): AccountStorage {
  storage.main = {
    type: 'opencode',
    provider: 'anthropic',
    ...storage.main,
    profile: {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: Date.now(),
      ...storage.main?.profile,
      providerAccountUuid: identity,
      tokenFingerprint: tokenFingerprint(access),
    },
  }
  return storage
}

/**
 * Name the Claude account behind a legacy store's main quota snapshot, the
 * only form of it that migration imports. Migration keeps a main quota only
 * when the store recorded which account produced it: a main profile observed
 * for the migrated access token, and a snapshot carrying that account. A
 * snapshot keyed by nothing or by the slot label "main" is dropped, and
 * quota-based routing then waits for a fresh snapshot instead.
 */
export function bindMainQuotaToAccount(
  storage: AccountStorage,
  access = 'sk-ant-oat01-main-access',
  identity: ProviderAccountUuid = syntheticMainAccountUuid,
): AccountStorage {
  const quota = storage.quota?.mainQuota
  if (!storage.quota || !quota)
    throw new Error('This store has no main quota to bind')
  bindMainAccount(storage, access, identity)
  storage.quota.mainQuota = { ...quota, accountIdentity: identity }
  storage.quota.mainQuotaToken = tokenFingerprint(access)
  return storage
}

/** The Claude account a synthetic fallback login at `index` belongs to. */
export function syntheticFallbackAccountUuid(index: number) {
  return `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}` as ProviderAccountUuid
}

/**
 * Give a legacy store the account identities migration needs to carry its
 * quota into the native pool: the main login's account (see
 * bindMainQuotaToAccount, or bindMainAccount when there is no main quota),
 * and a Claude account UUID for each OAuth fallback that has none. Quota
 * snapshots and errors a fallback recorded under its slot id, or under no
 * account, are re-keyed to that UUID, as the legacy writer would have keyed
 * them had it known the account.
 */
export function bindPoolAccounts(
  storage: AccountStorage,
  access = 'sk-ant-oat01-main-access',
): AccountStorage {
  if (storage.quota?.mainQuota) bindMainQuotaToAccount(storage, access)
  else bindMainAccount(storage, access)
  storage.accounts.forEach((account, index) => {
    if (account.type !== 'oauth') return
    const uuid =
      account.anthropicAccountUuid ?? syntheticFallbackAccountUuid(index)
    account.anthropicAccountUuid = uuid
    const rebind = <T extends { accountIdentity?: string }>(value: T) =>
      value.accountIdentity === undefined ||
      value.accountIdentity === account.id
        ? { ...value, accountIdentity: uuid }
        : value
    if (account.quota) account.quota = rebind(account.quota)
    if (account.lastRefreshError)
      account.lastRefreshError = rebind(account.lastRefreshError)
    if (account.lastQuotaRefreshError)
      account.lastQuotaRefreshError = rebind(account.lastQuotaRefreshError)
  })
  return storage
}

/**
 * Main OAuth credential stored in the fixture's OpenCode auth.json.
 * The Anthropic OAuth access-token prefix enables the bootstrap request that
 * verifies its account UUID. Arbitrary token strings must not gain access.
 */
export function syntheticMainHostAuth() {
  return {
    access: 'sk-ant-oat01-main-access',
    refresh: 'main-refresh',
    expires: Date.now() + 8 * 60 * 60_000,
  }
}

/**
 * Serialize raw old-installation input without interpreting or merging it.
 * Migration, not this fixture writer, owns its meaning.
 */
export async function legacyAccountFiles(storage: AccountStorage) {
  const scratch = await mkdtemp(join(tmpdir(), 'anthropic-plugin-legacy-'))
  const configPath = join(scratch, 'anthropic-auth.json')
  const statePath = join(scratch, 'anthropic-auth-state.json')
  try {
    await writeLegacyAccountFiles(configPath, storage, statePath, {
      version: 1,
      main: {},
      accounts: {},
    })
    return {
      config: await readFile(configPath, 'utf8'),
      state: await readFile(statePath, 'utf8').catch(() => undefined),
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Run offline migration to transfer the fixture's old account files and
 * OpenCode OAuth credential into shared storage. Construct plugins afterwards
 * so their startup reads see the committed authority journal and pool.
 */
export async function useTempAccountFile(
  ctx: Opencode1TestContext,
  storage: AccountStorage,
  mainHostAuth = syntheticMainHostAuth(),
) {
  const lifetime = getBodyLifetime(ctx)
  const root = await mkdtemp(join(tmpdir(), 'anthropic-plugin-test-'))
  // Register removal before migration can reject the directory. Cleanup
  // otherwise would not know about a directory created by failed setup.
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const legacy = await legacyAccountFiles(storage)
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime,
    legacyConfig: legacy.config,
    ...(legacy.state !== undefined && { legacyState: legacy.state }),
    hostAuth: { anthropic: { type: 'oauth', ...mainHostAuth } },
  })
  ctx.migratedPool = { ...fixture, mainHostAuth }
  registerPoolLogins(ctx, storage, mainHostAuth)
  // TestLifetime removes this directory after disposing its plugin instances
  // and joining their asynchronous work.
  ctx.tempConfigDir = fixture.root
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  delete process.env.OPENCODE_AUTH_CONTENT
}

/**
 * Remove the Prime start markers owned by the current fixture's account file.
 *
 * PrimeManager records "this account's five-hour window was already started"
 * as marker files under a temp root shared by every test in the process, in a
 * subdirectory named after a hash of the account storage path. Clearing only
 * that subdirectory keeps a stale marker from suppressing this test's request
 * without deleting markers that another test's plugin is still using. Call it
 * after useTempAccountFile and before creating a plugin: the account file must
 * exist so the hash matches the one the plugin computes. The same directory is
 * removed again once the test's plugins are disposed.
 */
export async function ownPrimeMarkerNamespace(
  ctx: Opencode1TestContext,
): Promise<void> {
  const storagePath = ctx.migratedPool?.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (!storagePath) throw new Error('Prime markers need a migrated pool first')
  // Core's default marker root; the plugin does not pass its own markerDir.
  const markerRoot = join(tmpdir(), 'opencode-anthropic-auth', 'prime')
  const namespace = primeMarkerNamespaceDir(markerRoot, storagePath)
  await rm(namespace, { recursive: true, force: true })
  getBodyLifetime(ctx).deferCleanup(() =>
    rm(namespace, { recursive: true, force: true }),
  )
}

export function registerPoolLogins(
  ctx: Opencode1TestContext,
  storage: AccountStorage,
  main: { access: string; refresh: string },
) {
  ctx.poolLogins.length = 0
  ctx.successorAccess.clear()
  const identityFor = (index: number) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  // Migration learns the main account UUID from its token-bound profile.
  // The bootstrap mock must return that same UUID for the migrated credential.
  ctx.poolLogins.push({
    ...main,
    identity: storage.main?.profile?.providerAccountUuid ?? identityFor(0),
  })
  storage.accounts.forEach((account, index) => {
    if (account.type !== 'oauth' || !account.access || !account.refresh) return
    ctx.poolLogins.push({
      access: account.access,
      refresh: account.refresh,
      identity: account.anthropicAccountUuid ?? identityFor(index + 1),
    })
  })
}

async function requestText(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === 'string') return init.body
  return input instanceof Request ? input.clone().text() : ''
}

/**
 * Synthetic Anthropic OAuth answers a migrated pool needs before it serves.
 * The native runtime checks the account behind a local OAuth login before
 * serving it. When the pool does not yet know that account, it exchanges the
 * login's refresh token first and reads the account of the new access token
 * (bootstrap); when it does, bootstrap alone confirms it. For a login this
 * test migrated, the token endpoint returns the same access and refresh tokens
 * with a fresh expiry, and bootstrap names the login's account; every other
 * request is left to the test's own mock.
 */
export async function nativeAdmissionAnswer(
  ctx: Opencode1TestContext,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response | undefined> {
  return (
    (await nativeTokenAnswer(ctx, input, init)) ??
    (await nativeBootstrapAnswer(ctx, input, init))
  )
}

/** The token-endpoint half of nativeAdmissionAnswer. */
export async function nativeTokenAnswer(
  ctx: Opencode1TestContext,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins?: readonly PoolLogin[],
): Promise<Response | undefined> {
  const effective = logins ?? ctx.poolLogins
  if (!extractUrl(input).includes('/v1/oauth/token')) return undefined
  let refresh: unknown
  try {
    refresh = JSON.parse(await requestText(input, init)).refresh_token
  } catch {
    return undefined
  }
  const login = effective.find((entry) => entry.refresh === refresh)
  if (!login) return undefined
  return Response.json({
    access_token: login.access,
    refresh_token: login.refresh,
    expires_in: 8 * 60 * 60,
  })
}

/**
 * Like withNativeAdmission, but for a test whose own mock answers bootstrap
 * (it checks which account bootstrap reports): only the token endpoint is
 * answered here.
 */
export function withNativeTokenExchange<Input, Init>(
  ctx: Opencode1TestContext,
  handler: (input: Input, init: Init) => Response | Promise<Response>,
): (input: Input, init: Init) => Promise<Response> {
  return async (input, init) =>
    (await nativeTokenAnswer(
      ctx,
      input as Parameters<typeof fetch>[0],
      init as RequestInit | undefined,
    )) ?? (await handler(input, init))
}

/** The Claude account the main login of this test's pool belongs to. */
export function poolMainIdentity(ctx: Opencode1TestContext): string {
  const main = ctx.poolLogins[0]
  if (!main) throw new Error('This test has no migrated local main login')
  return main.identity
}

/** Record that `accesses` are later tokens of the pool's main account. */
export function mainAccountIssues(
  ctx: Opencode1TestContext,
  ...accesses: string[]
) {
  const identity = poolMainIdentity(ctx)
  for (const access of accesses) ctx.successorAccess.set(access, identity)
}

/**
 * Record that `accesses` are later tokens of the account whose migrated
 * login has the access token `current`.
 */
export function loginIssues(
  ctx: Opencode1TestContext,
  current: string,
  ...accesses: string[]
) {
  const login = ctx.poolLogins.find((entry) => entry.access === current)
  if (!login) throw new Error(`No migrated login has access token ${current}`)
  for (const access of accesses) ctx.successorAccess.set(access, login.identity)
}

/**
 * Bootstrap's answer for an access token of this test's pool, or for a
 * later token of one of its accounts; undefined for anything else, which the
 * test's own mock then answers.
 */
export async function nativeBootstrapAnswer(
  ctx: Opencode1TestContext,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  logins?: readonly PoolLogin[],
): Promise<Response | undefined> {
  const effective = logins ?? ctx.poolLogins
  if (!extractUrl(input).includes('/api/claude_cli/bootstrap')) return undefined
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  const bearer = headers.get('authorization')?.replace(/^Bearer /, '')
  const known = new Set(effective.map((entry) => entry.identity))
  const successor =
    bearer === undefined ? undefined : ctx.successorAccess.get(bearer)
  const identity =
    effective.find((entry) => entry.access === bearer)?.identity ??
    (successor !== undefined && known.has(successor) ? successor : undefined)
  if (!identity) return undefined
  return Response.json({ oauth_account: { account_uuid: identity } })
}

export function withNativeAdmission<Input, Init>(
  ctx: Opencode1TestContext,
  handler: (input: Input, init: Init) => unknown,
): (input: Input, init: Init) => Promise<unknown> {
  return async (input, init) =>
    (await nativeAdmissionAnswer(
      ctx,
      input as Parameters<typeof fetch>[0],
      init as RequestInit | undefined,
    )) ?? handler(input, init)
}

/**
 * Answer exchange and bootstrap requests for the primary account only.
 * Let the test's handler control these endpoints for its fallback accounts.
 */
export function withMainAdmission<Input, Init>(
  ctx: Opencode1TestContext,
  handler: (input: Input, init: Init) => Response | Promise<Response>,
): (input: Input, init: Init) => Promise<Response> {
  return async (input, init) => {
    const main = ctx.poolLogins.slice(0, 1)
    const request = input as Parameters<typeof fetch>[0]
    const options = init as RequestInit | undefined
    return (
      (await nativeTokenAnswer(ctx, request, options, main)) ??
      (await nativeBootstrapAnswer(ctx, request, options, main)) ??
      handler(input, init)
    )
  }
}

/**
 * Answer account-bootstrap requests, but leave OAuth exchange requests to
 * the test's handler so it can count refreshes or return rotated tokens.
 */
export function withNativeBootstrap<Input, Init>(
  ctx: Opencode1TestContext,
  handler: (input: Input, init: Init) => unknown,
): (input: Input, init: Init) => Promise<unknown> {
  return async (input, init) =>
    (await nativeBootstrapAnswer(
      ctx,
      input as Parameters<typeof fetch>[0],
      init as RequestInit | undefined,
    )) ?? handler(input, init)
}
/**
 * Replace the primary OAuth credential through a separate account runtime.
 * With sameAccount=true, register the new access token under the existing
 * account UUID; otherwise the test supplies its own bootstrap response.
 * accountIdentity supplies an already known UUID; token validation still
 * runs before serving. The plugin discovers the change from shared storage.
 */
export async function replacePoolMainLogin(
  ctx: Opencode1TestContext,
  credential: { access: string; refresh: string; expires: number },
  options: { sameAccount: boolean; accountIdentity?: string } = {
    sameAccount: true,
  },
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  if (options.sameAccount) {
    mainAccountIssues(ctx, credential.access)
    ctx.poolLogins.push({ ...credential, identity: poolMainIdentity(ctx) })
  }
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.loginOAuth({
      routeId: 'main',
      replace: true,
      credential,
      ...(options.accountIdentity
        ? { accountIdentity: options.accountIdentity }
        : {}),
    })
  } finally {
    runtime.close()
  }
}

/** Require all stored fields that a known-account publication must carry. */
export function requireKnownPoolSubject(
  subject: NativeRefreshSubject,
): Parameters<
  ReturnType<typeof createNativeAccountRuntime>['publishLocal']
>[0] {
  const { binding, credentialFingerprint, version } = subject
  if (
    !binding.identity ||
    !credentialFingerprint ||
    !version?.accessFingerprint ||
    version.expires === undefined
  )
    throw new Error('Expected a complete known pool credential subject')
  return {
    binding: { ...binding, identity: binding.identity },
    credentialFingerprint,
    version: {
      ...version,
      accessFingerprint: version.accessFingerprint,
      expires: version.expires,
    },
  }
}

/**
 * Refresh the pool's main login in another plugin process; see
 * refreshPoolLoginElsewhere.
 */
export async function refreshPoolMainElsewhere(
  ctx: Opencode1TestContext,
  successor: {
    access: string
    refresh: string
    expires: number
  },
) {
  mainAccountIssues(ctx, successor.access)
  await refreshPoolLoginElsewhere(ctx, 'main', successor)
}

/**
 * Wait for an account-bound credential write without changing test deadlines:
 * re-read the pool until the successor lands or the test ends.
 */
export async function waitForPoolCredential(
  ctx: Opencode1TestContext,
  routeId: string,
  access: string,
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('Expected migrated pool')
  const reader = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  const store = createNativePoolStore({
    paths: pool.paths,
    quota: nativeQuotaCodec,
  })
  const changes = untilStateOrTestEnd(ctx, STATE_READ_PAUSE_MS)
  try {
    while (!changes.ended) {
      await changes.next()
      const subject = await reader.captureLocalSubject(routeId)
      const read = await store.read()
      const row =
        read.status === 'ready'
          ? read.rows.find((row) => row.id === subject.binding.rowId)
          : undefined
      const credential = row?.credential
      if (
        row?.stamp === 'bound' &&
        row.identity === subject.binding.identity &&
        row.credentialEpoch === subject.binding.credentialEpoch &&
        credential?.type === 'oauth' &&
        credential.access === access &&
        subject.version?.accessFingerprint === tokenFingerprint(access)
      )
        return { subject, credential }
    }
    throw new Error(
      `Expected a persisted native OAuth successor for ${routeId}`,
    )
  } finally {
    changes.close()
    reader.close()
  }
}

/**
 * Rotate the chosen account's tokens using a separate account runtime.
 * Register the returned access token with loginIssues or mainAccountIssues
 * before calling this helper, so bootstrap confirms its account UUID.
 * The injected exchange returns successor directly; the tested plugin's
 * exchange mock must see no request for this externally completed rotation.
 */
export async function refreshPoolLoginElsewhere(
  ctx: Opencode1TestContext,
  routeId: string,
  successor: { access: string; refresh: string; expires: number },
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
    local: {
      refreshToken: async () => ({
        ...successor,
        expiresIn: Math.round((successor.expires - Date.now()) / 1000),
      }),
    },
  })
  try {
    const result = await runtime.authorizeLocal(routeId, { intent: 'refresh' })
    if (result.status !== 'usable' || result.access !== successor.access)
      throw new Error(
        `Refresh of ${routeId} elsewhere did not complete: ${result.status} ${'reason' in result ? result.reason : ''}`,
      )
  } finally {
    runtime.close()
  }
}

/**
 * Commit the caller's settings update using a separate account runtime.
 * The tested plugin must discover the change by rereading shared storage.
 */
export async function updatePoolSettings(
  ctx: Opencode1TestContext,
  mutator: (settings: Record<string, unknown>) => Record<string, unknown>,
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateSettings(mutator)
  } finally {
    runtime.close()
  }
}

/**
 * Add an alternative OAuth account through a separate account runtime.
 * Its tokens belong only in shared storage, never in OpenCode's auth.json.
 * Sign-in verifies which Claude account the access token belongs to; here
 * that lookup answers `accountIdentity` (a new synthetic account by default)
 * instead of calling the bootstrap endpoint.
 */
export async function addPoolOAuthAccount(
  ctx: Opencode1TestContext,
  routeId: string,
  credential: { access: string; refresh: string; expires: number },
  accountIdentity: string = randomUUID(),
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
    local: {
      resolveIdentity: async () => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: accountIdentity as ProviderAccountUuid,
      }),
    },
  })
  try {
    await runtime.loginOAuth({ routeId, credential, replace: false })
  } finally {
    runtime.close()
  }
}

/**
 * Commit relay configuration using the account runtime's updateRelay API.
 * This keeps the relay secret outside the public settings projection.
 */
export async function updatePoolRelay(
  ctx: Opencode1TestContext,
  patch: Parameters<
    ReturnType<typeof createNativeAccountRuntime>['updateRelay']
  >[0],
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateRelay(patch)
  } finally {
    runtime.close()
  }
}

/**
 * Publish a usage reading from a separate account runtime, tagged with the
 * account UUID verified for the credential that authorized the reading.
 */
export function publishPoolQuota(
  ctx: Opencode1TestContext,
  routeId: string,
  quota: OAuthQuotaSnapshot,
) {
  return publishPoolMetadata(ctx, routeId, (identity) => ({
    quota: { ...quota, accountIdentity: identity },
  }))
}

/**
 * Authorize the account using a separate runtime, then publish quota or error
 * metadata for that exact credential version. A concurrent credential change
 * must make publication refuse rather than attach metadata to the new login.
 */
export async function publishPoolMetadata(
  ctx: Opencode1TestContext,
  routeId: string,
  patch: (
    identity: string,
  ) => Parameters<
    ReturnType<typeof createNativeAccountRuntime>['publishLocal']
  >[1],
  options: Pick<
    Parameters<typeof createNativeAccountRuntime>[0],
    'beforePoolWrite'
  > = {},
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
    ...options,
  })
  try {
    const authorization = await runtime.authorizeLocal(routeId)
    if (authorization.status !== 'usable')
      throw new Error(`Pool ${routeId} login is not usable`)
    const identity = authorization.binding.identity
    if (identity === undefined)
      throw new Error(`Pool ${routeId} login has no confirmed account`)
    const published = await runtime.publishLocal(
      authorization.subject,
      patch(identity),
    )
    if (!published) throw new Error(`Metadata for ${routeId} was not published`)
  } finally {
    // Quota publication acknowledges queue admission, not a disk commit. A
    // separate runtime can observe the reading only after this store drains.
    await runtime.close()
  }
}

/**
 * Check that OpenCode's auth store still holds only the placeholder login
 * migration wrote for Anthropic: no access or refresh token reached it.
 */
export async function expectHostActivationNonSecret(
  ctx: Opencode1TestContext,
  ...tokens: string[]
) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const text = await readFile(pool.hostAuthPath, 'utf8')
  expect(isCustodyTombstoneOAuth(JSON.parse(text).anthropic, 'anthropic')).toBe(
    true,
  )
  for (const token of tokens) expect(text).not.toContain(token)
}

/**
 * The access token the pool would hand a new caller for its main login, read
 * through a separate native runtime the way another plugin process would.
 */
export async function poolMainAccess(
  ctx: Opencode1TestContext,
): Promise<string> {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const result = await runtime.authorizeLocal('main')
    if (result.status !== 'usable')
      throw new Error(`Pool main login is not usable: ${result.status}`)
    return result.access
  } finally {
    runtime.close()
  }
}

/**
 * Return the non-secret activation marker written to OpenCode's auth.json.
 * Reject fixture credentials that differ from those imported by migration;
 * the host loader cannot supply an unrelated login as pool authority.
 */
export async function migratedHostAuth(
  _ctx: Opencode1TestContext,
  pool: MigratedPool,
  testAuth: () => Promise<Record<string, unknown>>,
) {
  const supplied = await testAuth()
  if (
    supplied.type !== 'oauth' ||
    isCustodyTombstoneOAuth(supplied, 'anthropic')
  )
    return supplied
  const migrated = pool.mainHostAuth
  if (
    supplied.access !== migrated.access ||
    supplied.refresh !== migrated.refresh ||
    (typeof supplied.expires === 'number' && supplied.expires <= Date.now()) !==
      migrated.expires <= Date.now()
  )
    throw new Error(
      `Test host OAuth ${String(supplied.access)} is not the login migrated into this pool (${migrated.access})`,
    )
  return JSON.parse(await readFile(pool.hostAuthPath, 'utf8')).anthropic
}

export const syntheticMainIdentity = '11111111-1111-4111-8111-111111111111'

/** A synthetic vault whose listing holds only the main account's credential
 * row; any attempt to read that credential's token makes the test fail. */
export function mainOnlyVault(): NativeCustodyClient {
  return {
    async listScoped() {
      return {
        view: 'synthetic-native-view',
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: syntheticMainIdentity,
            credentialType: 'oauth',
            state: 'active',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            providerIds: [],
            refreshAdapter: 'anthropic',
            recordVersion: 1,
            operations: ['read', 'invalidate'],
            createdAtMs: 1,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      throw new Error('Status tests must not read vault credential material')
    },
    async reportAuthFailureScoped() {
      throw new Error('Status tests must not report vault failures')
    },
    close() {},
  }
}

/**
 * Run setup migration for accounts whose credentials remain in the vault.
 * The fixture's enrollment token permits listing vault accounts for this host.
 * Plugin startup then reads the committed, credential-free account inventory.
 */
export async function useVaultAccountFile(
  ctx: Opencode1TestContext,
  storage: AccountStorage,
  client: NativeCustodyClient,
) {
  const lifetime = getBodyLifetime(ctx)
  const root = await mkdtemp(join(tmpdir(), 'anthropic-plugin-vault-'))
  lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const legacy = await legacyAccountFiles(storage)
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime,
    legacyConfig: legacy.config,
    ...(legacy.state !== undefined && { legacyState: legacy.state }),
    hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
    custody: {
      connect: async () => client,
      enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
    },
  })
  ctx.poolLogins.length = 0
  // In vault custody auth.json never held the main tokens; it already holds
  // the placeholder login, so there is no local main login to compare.
  ctx.migratedPool = {
    ...fixture,
    mainHostAuth: { access: '', refresh: '', expires: 0 },
  }
  ctx.tempConfigDir = fixture.root
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  delete process.env.OPENCODE_AUTH_CONTENT
  return fixture
}

/**
 * Keep the old account files without running migration. Tests can then
 * verify that plugin startup neither adopts their credentials nor rewrites them.
 */
export async function useUnmigratedAccountFile(
  ctx: Opencode1TestContext,
  storage: AccountStorage,
) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-plugin-unmigrated-'))
  getBodyLifetime(ctx).deferCleanup(() =>
    rm(root, { recursive: true, force: true }),
  )
  ctx.migratedPool = undefined
  ctx.poolLogins.length = 0
  ctx.tempConfigDir = root
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(root, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    root,
    'anthropic-auth-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    root,
    'sidebar-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    root,
    'opencode-enrollment.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    root,
    'missing-connection.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    root,
    'cachekeep-registry',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    root,
    'quota-header-feed',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(root, 'rpc')
  await writeLegacyAccountFiles(
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE,
    storage,
  )
}

/**
 * Fail if `value` (stored account metadata, a recorded error) carries any
 * part of an OAuth token or API key this test's pool knows: an access or
 * refresh token of a migrated login or of a later login of its accounts, or
 * any `sk-ant-` token prefix.
 */
export function expectNoCredentialFragment(
  ctx: Opencode1TestContext,
  value: unknown,
) {
  const text = JSON.stringify(value ?? null)
  expect(text).not.toContain('sk-ant-')
  for (const login of ctx.poolLogins) {
    expect(text).not.toContain(login.access)
    expect(text).not.toContain(login.refresh)
  }
  for (const access of ctx.successorAccess.keys())
    expect(text).not.toContain(access)
}

/** Settings as the native runtime reads them back from the migrated pool. */
export async function readNativeSettings(
  ctx: Opencode1TestContext,
): Promise<Record<string, unknown>> {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    return (await runtime.read()).settings
  } finally {
    runtime.close()
  }
}

/** Publish a poll through the current native credential's guarded writer. */
export async function publishNativeMainQuota(
  ctx: Opencode1TestContext,
  quota: OAuthQuotaSnapshot,
) {
  if (!ctx.migratedPool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: ctx.migratedPool.paths,
    host: 'opencode',
  })
  try {
    const authorization = await runtime.authorizeLocal('main')
    if (authorization.status !== 'usable')
      throw new Error(
        `Main quota publication cannot authorize: ${authorization.status}`,
      )
    if (!authorization.binding.identity)
      throw new Error('Main quota publication requires an account UUID')
    if (
      !(await runtime.publishLocal(authorization.subject, {
        quota: { ...quota, accountIdentity: authorization.binding.identity },
      }))
    )
      throw new Error('Main quota publication refused the current credential')
    return authorization.subject
  } finally {
    await runtime.close()
  }
}

/**
 * Per-account runtime state as the native pool records it, in the shape of
 * the retired legacy state file: `main` and `accounts[routeId]`, each with
 * its account identity, quota, profile, prime counters and recorded errors. The main
 * account's quota error keeps its legacy name, `lastQuotaApiError`. Native
 * reads carry no credential material.
 */
export async function readNativeRuntimeState(ctx: Opencode1TestContext) {
  const pool = ctx.migratedPool
  if (!pool) throw new Error('This test has no migrated pool')
  const runtime = createNativeAccountRuntime({
    paths: pool.paths,
    host: 'opencode',
  })
  try {
    const snapshot = await runtime.read()
    const project = (account: (typeof snapshot.accounts)[number]) => ({
      accountIdentity: account.accountIdentity,
      quota: account.quota,
      profile: account.profile,
      prime: account.prime,
      lastRefreshError: account.lastRefreshError,
      lastQuotaRefreshError: account.lastQuotaRefreshError,
    })
    const main = snapshot.accounts.find((account) => account.id === 'main')
    return {
      main: main && {
        ...project(main),
        lastQuotaApiError: main.lastQuotaRefreshError,
      },
      accounts: Object.fromEntries(
        snapshot.accounts
          .filter((account) => account.id !== 'main')
          .map((account) => [account.id, project(account)]),
      ),
    }
  } finally {
    runtime.close()
  }
}

export function disabledPluginRuntimeOverrides(): PluginRuntimeOverrides {
  return {
    // Background intervals must not outlive the test-scoped fetch mock they captured.
    setInterval: mock(
      () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
    ) as unknown as typeof setInterval,
    clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    scopedRosterPollIntervalMs: 0,
    cacheKeepAggregateRefreshIntervalMs: 0,
    // /claude without a polling TUI replies in the chat at once instead of
    // waiting the real two seconds for a TUI to take the menu.
    tuiPickupTimeoutMs: 0,
  }
}

export async function getPlugin(
  ctx: Opencode1TestContext,
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
) {
  const defaultTimerOverrides = disabledPluginRuntimeOverrides()
  const creation = (
    AnthropicAuthPlugin as unknown as (
      ctxParam: Parameters<typeof AnthropicAuthPlugin>[0],
      runtimeOverrides?: PluginRuntimeOverrides,
    ) => ReturnType<typeof AnthropicAuthPlugin>
  )(
    {
      // @ts-expect-error: minimal mock for testing
      client: client ?? createMockClient(),
      ...(directory && { directory }),
    },
    {
      ...defaultTimerOverrides,
      ...ctx.pluginRuntimeOverrides,
      ...runtimeOverrides,
    },
  )
  ctx.testLifetime?.trackDetached(creation)
  const plugin = (await creation) as TestPlugin
  ctx.livePlugins.add(plugin)
  ctx.fallbackRefreshes.add(getPluginTestHandles(plugin).fallbackRefreshReady)
  const pool = ctx.migratedPool
  const loader = plugin.auth?.loader
  if (pool && loader) {
    // After migration, OpenCode's auth store answers with the inert
    // activation, not the test's literal OAuth tokens.
    plugin.auth.loader = (
      hostGetAuth: () => Promise<Record<string, unknown>>,
      provider: unknown,
    ) => loader(() => migratedHostAuth(ctx, pool, hostGetAuth), provider)
  }
  return plugin
}

/**
 * Set up the common test scaffolding for concurrent refresh tests:
 * mocks setTimeout to be synchronous and creates a plugin loader
 * whose migrated main login has an already-expired access token.
 * The tokens the test's token endpoint issues are later tokens of that
 * same account. Quota routing is off, so every request is actually sent
 * with the refreshed token rather than answered locally for unknown quota.
 */
export async function setupExpiredTokenLoader(
  ctx: Opencode1TestContext,
  ...issuedAccess: string[]
) {
  const expiredLogin = {
    access: 'sk-ant-oat01-expired-token',
    refresh: 'old-refresh',
    expires: Date.now() - 1000,
  }
  await useTempAccountFile(
    ctx,
    createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    expiredLogin,
  )
  mainAccountIssues(ctx, ...issuedAccess)
  const setTimeoutMock = mock((handler: () => unknown) => {
    handler()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout

  const mockClient = createMockClient()
  const plugin = await getPlugin(ctx, mockClient, undefined, {
    setTimeout: setTimeoutMock,
  })
  const result = await plugin.auth.loader(
    () => Promise.resolve({ type: 'oauth', ...expiredLogin }),
    { models: {} },
  )

  return { mockClient, result }
}
