import { expect, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  acquireRefreshFileLock,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  getLogLevel,
  getStickyRoutingStatePath,
  type LogTestRecord,
  type ProviderAccountUuid,
  publishNativeEmptyInit,
  resetClaudeCodeIdentityCachesForTest,
  resolveLocalRoutingDestination,
  runNativeMigration,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { createOpencodeClient, type Provider } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { resolveNativeSetupPaths } from '../setup/native-paths.ts'
import { createNativeAnthropicSource } from '../v2/source.ts'

const tests = createTestLifetimeSuite()
const session1 = 'imported-session'
const session2 = 'post-upgrade-session'
const hash = (session: string) =>
  createHash('sha256').update(session).digest('hex')
const provider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}
const envKeys = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
] as const

function routing(pins: Record<string, string>) {
  const now = Date.now()
  return JSON.stringify({
    version: 1,
    updatedAt: now,
    assignments: Object.fromEntries(
      Object.entries(pins).map(([session, accountId]) => [
        hash(session),
        {
          accountId,
          family: 'fable',
          affinityModelId: 'claude-sonnet-4-6',
          assignedAt: now,
          lastSeenAt: now,
          initialInputBytes: 1,
          quotaCheckedAt: 0,
        },
      ]),
    ),
  })
}

async function fixture(override = false) {
  const root = await mkdtemp(join(tmpdir(), 'oc-routing-migration-'))
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const savedFetch = globalThis.fetch
  const cleanups: Array<() => void | Promise<void>> = []
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
      globalThis.fetch = savedFetch
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      resetClaudeCodeIdentityCachesForTest()
      await rm(root, { recursive: true, force: true })
    })())
  tests.deferCleanup(close)
  for (const key of envKeys) delete process.env[key]
  Object.assign(process.env, {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    OPENCODE_ANTHROPIC_AUTH_FILE: join(root, 'anthropic-auth.json'),
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: join(root, 'anthropic-auth-state.json'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'connection.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(root, 'cachekeep'),
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(root, 'rpc'),
    OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION: '1',
  })
  if (override)
    process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      root,
      'override-routing.json',
    )
  resetClaudeCodeIdentityCachesForTest()
  const resolved = await resolveNativeSetupPaths('opencode', process.env)
  const paths = resolved.paths
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({
      version: 1,
      refresh: { enabled: false },
      quota: { enabled: false },
      claudeCache: { enabled: false },
      routing: { mode: 'sticky-balanced' },
      accounts: [
        {
          id: 'secondary',
          type: 'oauth',
          enabled: true,
          access: 'sk-ant-oat01-secondary',
          refresh: 'synthetic-secondary-refresh',
          expires: Date.now() + 28_800_000,
        },
      ],
    }),
    { mode: 0o600 },
  )
  await mkdir(join(root, 'data', 'opencode'), { recursive: true })
  await writeFile(
    resolved.hostAuthPath,
    JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: 'sk-ant-oat01-primary',
        refresh: 'synthetic-primary-refresh',
        expires: Date.now() + 28_800_000,
      },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    resolved.routingSourcePath,
    routing({ [session1]: 'secondary' }),
    { mode: 0o600 },
  )
  const journal = await runNativeMigration({
    ...resolved,
    host: 'opencode',
    env: { ...process.env },
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  expect(journal.phase).toBe('retired')
  expect(
    JSON.parse(await readFile(journal.routingPaths.destination, 'utf8'))
      .assignments[hash(session1)].accountId,
  ).toBe('secondary')
  const sent: string[] = []
  const offlineFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const auth =
        new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get('authorization') ?? ''
      const uuid = auth.includes('secondary')
        ? '22222222-2222-4222-8222-222222222222'
        : '11111111-1111-4111-8111-111111111111'
      if (url.includes('/oauth/token'))
        return Response.json({
          access_token: `sk-ant-oat01-${String(init?.body).includes('secondary') ? 'secondary' : 'primary'}`,
          refresh_token: 'synthetic-successor-refresh',
          expires_in: 28800,
        })
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({ oauth_account: { account_uuid: uuid } })
      if (url.includes('/api/oauth/profile'))
        return Response.json({
          account: { uuid },
          organization: { uuid: 'synthetic-org', billing_type: 'stripe' },
        })
      if (url.includes('/api/oauth/usage'))
        return Response.json({
          five_hour: {
            utilization: 5,
            resets_at: new Date(Date.now() + 18_000_000).toISOString(),
          },
          seven_day: {
            utilization: 10,
            resets_at: new Date(Date.now() + 604_800_000).toISOString(),
          },
        })
      if (url.includes('/v1/messages')) {
        sent.push(auth)
        return Response.json({
          id: 'synthetic-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      throw new Error(`Unexpected offline request: ${url}`)
    },
    { preconnect: savedFetch.preconnect },
  )
  globalThis.fetch = offlineFetch
  const seed = createNativeAccountRuntime({ paths, host: 'opencode' })
  try {
    await seed.fetchQuota('main', offlineFetch)
    await seed.fetchQuota('secondary', offlineFetch)
  } finally {
    seed.close()
  }
  return { root, paths, journal, sent, offlineFetch, cleanups, close }
}

type HostFixture = Pick<
  Awaited<ReturnType<typeof fixture>>,
  'root' | 'paths' | 'sent' | 'offlineFetch' | 'cleanups'
>

async function oc1(f: HostFixture) {
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: f.offlineFetch,
      }),
      project: {
        id: 'routing-fixture',
        worktree: f.root,
        time: { created: Date.now() },
      },
      directory: f.root,
      worktree: f.root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    { scopedRosterPollIntervalMs: 0, cacheKeepAggregateRefreshIntervalMs: 0 },
  )
  tests.trackDetached(creation)
  const plugin = await creation
  f.cleanups.push(() => plugin.dispose?.())
  const options = await plugin.auth!.loader!(
    async () => custodyTombstoneOAuth('anthropic'),
    provider,
  )
  const handler = options.fetch as typeof fetch
  const send = async (session: string) => {
    const request = handler('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-affinity': session,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'offline routing probe' }],
      }),
    })
    tests.trackDetached(request)
    const response = await request
    expect(response.status).toBe(200)
    await response.text()
    return f.sent.at(-1)
  }
  return Object.assign(send, {
    dispose: async () => {
      await plugin.dispose?.()
    },
  })
}

async function oc2(f: HostFixture) {
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
  })
  f.cleanups.push(() => runtime.close())
  const source = createNativeAnthropicSource({
    runtime,
    paths: f.paths,
    requestOptions: () => ({}),
    fetch: f.offlineFetch,
  })
  f.cleanups.push(() => source.close())
  const send = async (sessionID: string) => {
    const scope = {
      phase: 'request' as const,
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
      sessionID,
      agent: 'build',
      kind: 'primary' as const,
    }
    const work = (async () => {
      const account = await source.chooseAccount(scope)
      if (typeof account !== 'string') throw new Error('No account chosen')
      const auth = await source.authorizeAccount(scope, account)
      if (auth?.route !== 'oauth')
        throw new Error('Offline OAuth authorization refused')
      return auth.accessToken
    })()
    tests.trackDetached(work)
    return work
  }
  return Object.assign(send, { dispose: () => source.close() })
}

async function emptyFixture(override: boolean): Promise<HostFixture> {
  const root = await mkdtemp(join(tmpdir(), 'oc-empty-routing-'))
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const savedFetch = globalThis.fetch
  const cleanups: HostFixture['cleanups'] = []
  tests.deferCleanup(async () => {
    const results = await Promise.allSettled(
      cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
    )
    globalThis.fetch = savedFetch
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetClaudeCodeIdentityCachesForTest()
    await rm(root, { recursive: true, force: true })
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  })
  for (const key of envKeys) delete process.env[key]
  Object.assign(process.env, {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    OPENCODE_ANTHROPIC_AUTH_FILE: join(root, 'legacy.json'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'enrollment.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'connection.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(root, 'cachekeep'),
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(root, 'rpc'),
    OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION: '1',
  })
  if (override)
    process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      root,
      'override.json',
    )
  resetClaudeCodeIdentityCachesForTest()
  const { paths, routingDestinationPath } = await resolveNativeSetupPaths(
    'opencode',
    process.env,
  )
  const destination = override
    ? process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE!
    : getStickyRoutingStatePath(paths.config)
  expect(resolveLocalRoutingDestination('opencode', paths, process.env)).toBe(
    destination,
  )
  expect(routingDestinationPath).toBe(destination)
  await publishNativeEmptyInit({
    paths,
    routingDestinationPath,
    env: { ...process.env },
    processFence: async () => {},
  })
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      resolveIdentity: async (access) => ({
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
        accountUuid: (access.includes('secondary')
          ? '22222222-2222-4222-8222-222222222222'
          : '11111111-1111-4111-8111-111111111111') as ProviderAccountUuid,
      }),
    },
  })
  cleanups.push(() => runtime.close())
  for (const [routeId, name] of [
    ['main', 'primary'],
    ['secondary', 'secondary'],
  ] as const)
    await runtime.loginOAuth({
      routeId,
      credential: {
        access: `sk-ant-oat01-${name}`,
        refresh: `synthetic-${name}-refresh`,
        expires: Date.now() + 28_800_000,
      },
    })
  await runtime.updateSettings((settings) => ({
    ...settings,
    refresh: { enabled: false },
    quota: { enabled: false },
    routing: { mode: 'sticky-balanced' },
  }))
  await writeFile(destination, routing({ [session1]: 'secondary' }))
  const sent: string[] = []
  const offlineFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const auth =
        new Headers(
          init?.headers ??
            (input instanceof Request ? input.headers : undefined),
        ).get('authorization') ?? ''
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({
          oauth_account: {
            account_uuid: auth.includes('secondary')
              ? '22222222-2222-4222-8222-222222222222'
              : '11111111-1111-4111-8111-111111111111',
          },
        })
      if (!url.includes('/v1/messages'))
        throw new Error('Unexpected empty-init network request')
      expect(new Headers(init?.headers).get('x-api-key')).toBeNull()
      sent.push(auth)
      return Response.json({
        id: 'synthetic-message',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    },
    { preconnect: savedFetch.preconnect },
  )
  globalThis.fetch = offlineFetch
  return { root, paths, sent, offlineFetch, cleanups }
}

for (const [host, open] of [
  ['OC1', oc1],
  ['OC2', oc2],
] as const) {
  for (const override of [false, true])
    tests.test(
      `${host} empty-init routing reads and writes the ${override ? 'override' : 'derived'} destination`,
      async () => {
        const f = await emptyFixture(override)
        const send = await open(f)
        expect(await send(session1)).toContain('sk-ant-oat01-secondary')
        await send(session2)
        await send.dispose()
        const destination = resolveLocalRoutingDestination(
          'opencode',
          f.paths,
          process.env,
        )
        const persisted = JSON.parse(await readFile(destination, 'utf8'))
        expect(persisted.assignments[hash(session1)].accountId).toBe(
          'secondary',
        )
        expect(persisted.assignments[hash(session2)]).toBeDefined()
      },
    )
}

for (const [host, open] of [
  ['OC1', oc1],
  ['OC2', oc2],
] as const) {
  tests.test(
    `${host} first local request reuses the offline migration destination pin`,
    async () => {
      const f = await fixture()
      const send = await open(f)
      expect(await send(session1)).toContain('sk-ant-oat01-secondary')
    },
  )
}

tests.test(
  'local routing gap-fill preserves destination pins and the legacy file',
  async () => {
    for (const open of [oc1, oc2]) {
      const f = await fixture()
      const destination = f.journal.routingPaths.destination
      const legacy = getStickyRoutingStatePath(f.paths.legacyConfig)
      await writeFile(destination, routing({ [session1]: 'main' }))
      const legacyBytes = routing({
        [session1]: 'secondary',
        [session2]: 'secondary',
        'missing-account-session': 'removed-account',
      })
      await writeFile(legacy, legacyBytes)
      const send = await open(f)
      expect(await send(session1)).toContain('sk-ant-oat01-primary')
      await send.dispose()
      const state = JSON.parse(await readFile(destination, 'utf8'))
      expect(state.assignments[hash(session1)].accountId).toBe('main')
      expect(state.assignments[hash(session2)].accountId).toBe('secondary')
      expect(state.assignments[hash('missing-account-session')].accountId).toBe(
        'removed-account',
      )
      const resumed = await open(f)
      expect(await resumed(session2)).toContain('sk-ant-oat01-secondary')
      await resumed.dispose()
      expect(await readFile(legacy, 'utf8')).toBe(legacyBytes)
      // A second router in the same process must not import newly added source pins.
      const lateBytes = routing({ 'late-session': 'secondary' })
      await writeFile(legacy, lateBytes)
      const second = await open(f)
      await second(session1)
      await second.dispose()
      expect(
        JSON.parse(await readFile(destination, 'utf8')).assignments[
          hash('late-session')
        ],
      ).toBeUndefined()
      expect(await readFile(legacy, 'utf8')).toBe(lateBytes)
      await f.close()
    }
  },
)

tests.test(
  'routing override is shared by migration OC1 and OC2 without recovery',
  async () => {
    const f = await fixture(true)
    expect(f.journal.routingPaths.source).toBe(
      f.journal.routingPaths.destination,
    )
    const legacy = getStickyRoutingStatePath(f.paths.legacyConfig)
    const poison = 'not a routing document: recovery must not open this file'
    await writeFile(legacy, poison)
    const runtime = createNativeAccountRuntime({
      paths: f.paths,
      host: 'opencode',
    })
    f.cleanups.push(() => runtime.close())
    expect((await runtime.read()).routingRecoveryPath).toBeUndefined()
    for (const open of [oc1, oc2]) {
      const send = await open(f)
      expect(await send(session1)).toContain('sk-ant-oat01-secondary')
    }
    expect(await readFile(legacy, 'utf8')).toBe(poison)
  },
)

for (const failure of ['malformed', 'unreadable', 'locked'] as const) {
  tests.test(
    failure === 'locked'
      ? 'local routing serves destination pins while legacy recovery waits in the background'
      : `local routing serves destination pins after ${failure} legacy recovery fails`,
    async () => {
      for (const open of [oc1, oc2]) {
        const f = await fixture()
        try {
          const legacy = getStickyRoutingStatePath(f.paths.legacyConfig)
          const bytes =
            failure === 'malformed'
              ? '{synthetic-private-incomplete-json'
              : routing({ [session1]: 'main' })
          await writeFile(legacy, bytes)
          const send = await open(f)
          const records: LogTestRecord[] = []
          const previousLevel = getLogLevel()
          setLogLevel('warn')
          __setLogTestSink((record) => records.push(record))
          f.cleanups.push(() => {
            __setLogTestSink(null)
            setLogLevel(previousLevel)
          })
          let deniedReads = 0
          let restoreRead = () => {}
          if (failure === 'unreadable') {
            // Inject EACCES so the file stays unreadable even in root-run test jobs.
            const originalRead = fs.readFile
            const read = spyOn(fs, 'readFile').mockImplementation(((
              ...args: Parameters<typeof fs.readFile>
            ) => {
              if (args[0] === legacy) {
                deniedReads++
                return Promise.reject(
                  Object.assign(new Error('synthetic-private-read-error'), {
                    code: 'EACCES',
                  }),
                )
              }
              return originalRead(...args)
            }) as typeof fs.readFile)
            restoreRead = () => read.mockRestore()
            f.cleanups.push(restoreRead)
          }
          let held: Awaited<ReturnType<typeof acquireRefreshFileLock>> = null
          if (failure === 'locked') {
            const lock = await acquireRefreshFileLock({
              path: f.journal.routingPaths.destination,
              name: 'write',
              ttlMs: 60_000,
              renew: true,
            })
            if (!lock)
              throw new Error('Fixture could not hold the routing lock')
            held = lock
            f.cleanups.push(() => lock.release())
          }
          expect(await send(session1)).toContain('sk-ant-oat01-secondary')
          expect(await send(session1)).toContain('sk-ant-oat01-secondary')
          await held?.assertOwned()
          await held?.release()
          await send.dispose()
          expect(
            records.filter(
              (record) =>
                record.channel === 'sticky-routing' && record.level === 'warn',
            ),
          ).toEqual(
            failure === 'locked'
              ? []
              : [
                  {
                    level: 'warn',
                    channel: 'sticky-routing',
                    message: 'local pin recovery unavailable',
                    payload: { reason: 'recovery-failed' },
                  },
                ],
          )
          if (failure === 'unreadable') expect(deniedReads).toBe(1)
          restoreRead()
          expect(await readFile(legacy, 'utf8')).toBe(bytes)
        } finally {
          await f.close()
        }
      }
    },
  )
}
