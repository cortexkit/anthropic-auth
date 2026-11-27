import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  createNativeAccountRuntime,
  getClaudeCodeIdentityForVerifiedAccount,
  getLogLevel,
  getStickyRoutingStatePath,
  type LogTestRecord,
  NativeTransientAccountError,
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
  TOKEN_URL,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat'
import {
  localAuthFixtureQuota,
  localAuthRefusalScenarios,
  seedLocalAuthRefusal,
} from '../../../core/src/tests/local-auth-refusal-fixture.ts'
import { TestLifetime } from '../../../core/src/tests/test-lifetime.ts'
import {
  closePiNativeRuntime,
  getPiNativeRuntime,
  PiNativeRuntime,
} from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

const model: Model<Api> = {
  id: 'claude-fable-5-1',
  name: 'Fable',
  provider: 'anthropic',
  api: 'cortexkit-anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}
const success = () =>
  new Response(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  )
const originalFetch = globalThis.fetch
let directory: string
let storagePath: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-native-serving-'))
  storagePath = join(directory, 'anthropic-auth.json')
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          type: 'api',
          id: 'paid',
          apiKey: 'synthetic-native-paid-key',
          baseURL: 'https://paid.invalid',
        },
      ],
    },
    storagePath,
    { mainAccess: 'sk-ant-oat01-synthetic-native-main-access' },
  )
})
afterEach(async () => {
  await closePiNativeRuntime(storagePath)
  globalThis.fetch = originalFetch
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  await rm(directory, { recursive: true, force: true })
})

for (const mode of ['main-first', 'sticky-balanced'] as const) {
  test.each(localAuthRefusalScenarios)(
    `#916 Pi ${mode}: %s`,
    async (scenario) => {
      const alternateAccess = 'sk-ant-oat01-pi-refusal-alternate'
      const alternate =
        scenario === 'live alternate' || scenario === 'quota-blocked alternate'
      await saveNativePiFixture(
        {
          version: 1,
          routing: { mode },
          quota: {
            enabled: alternate,
            minimumRemaining: { five_hour: 10, seven_day: 10 },
          },
          accounts: alternate
            ? [
                {
                  type: 'oauth',
                  id: 'alternate',
                  access: alternateAccess,
                  refresh: 'pi-alternate-refresh',
                  expires: Date.now() + 3_600_000,
                  quota: localAuthFixtureQuota(
                    scenario === 'live alternate' ? 70 : 5,
                  ),
                },
                {
                  type: 'api',
                  id: 'paid',
                  apiKey: 'unused',
                  baseURL: 'https://paid.invalid',
                  enabled: false,
                },
              ]
            : [
                {
                  type: 'api',
                  id: 'paid',
                  apiKey: 'unused',
                  baseURL: 'https://paid.invalid',
                  enabled: false,
                },
              ],
        },
        storagePath,
      )
      const waiting =
        scenario === 'validation wait' || scenario === 'stale record'
      await seedLocalAuthRefusal(
        await resolveNativePoolPaths(storagePath),
        waiting
          ? scenario === 'stale record'
            ? 'stale'
            : 'validation'
          : 'dead',
      )
      const outbound: [string, string | null][] = []
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const path = new URL(String(input)).pathname
          outbound.push([path, new Headers(init?.headers).get('authorization')])
          if (path === '/v1/messages') return success()
          throw new Error(`Unexpected provider request: ${path}`)
        },
        { preconnect: originalFetch.preconnect },
      )
      const result = await streamCortexKitAnthropic(model, context, {
        sessionId: 'pi-refusal',
      }).result()
      if (scenario === 'live alternate') {
        expect(result.stopReason).toBe('stop')
        expect(outbound).toEqual([
          ['/v1/messages', `Bearer ${alternateAccess}`],
        ])
      } else {
        expect(result.stopReason).toBe('error')
        if (waiting) {
          expect(result.errorMessage).toStartWith(
            mode === 'sticky-balanced'
              ? 'Sticky-balanced routing is waiting for current OAuth quota snapshots'
              : "Claude couldn't confirm which account this login belongs to",
          )
        } else {
          expect(result.errorMessage).toContain('HTTP 401')
          expect(result.errorMessage).toContain(
            '"type":"authentication_error","message":"Main Claude OAuth account requires re-login',
          )
          if (alternate) expect(result.errorMessage).toContain('quota floor')
        }
        expect(outbound).toEqual([])
      }
    },
  )
}

test('a failed post-refresh Claude lookup in Pi recovers on the scheduled check', async () => {
  await saveNativePiFixture(
    { version: 1, accounts: [], quota: { enabled: false } },
    storagePath,
  )
  const successor = 'sk-ant-oat01-pi-validation-successor'
  let status = 403
  const requests: string[] = []
  const sent: (string | null)[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push(url.pathname)
      if (url.href === TOKEN_URL)
        return Response.json({
          access_token: successor,
          refresh_token: 'pi-validation-successor-refresh',
          expires_in: 3600,
        })
      if (url.pathname === '/api/claude_cli/bootstrap')
        return Response.json(
          { oauth_account: { account_uuid: fixtureAccountIdentity('main') } },
          { status },
        )
      if (url.pathname === '/v1/messages') {
        sent.push(new Headers(init?.headers).get('authorization'))
        return success()
      }
      throw new Error(`Unexpected provider request: ${url.pathname}`)
    },
    { preconnect: originalFetch.preconnect },
  )
  const runtime = await getPiNativeRuntime(storagePath, {
    local: { now: () => Date.now() },
  }).service()
  const now = Date.now()
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  try {
    expect(
      await runtime.authorizeLocal('main', { intent: 'refresh' }),
    ).toMatchObject({
      status: 'refused',
      persisted: true,
      reason: 'validation-backoff',
    })
    status = 200
    const retryAt = now + 5 * 60_000
    const time = new Date(retryAt).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
    const turn = () => streamCortexKitAnthropic(model, context).result()
    clock.mockReturnValue(retryAt - 1)
    expect(await turn()).toMatchObject({
      stopReason: 'error',
      errorMessage: `Claude couldn't confirm which account this login belongs to. It will check again at ${time} UTC. To check now, use Reset account backoff in /claude.`,
    })
    expect(sent).toEqual([])
    expect(requests).toEqual([
      new URL(TOKEN_URL).pathname,
      '/api/claude_cli/bootstrap',
    ])

    clock.mockReturnValue(retryAt)
    expect((await turn()).stopReason).toBe('stop')
    expect(sent).toEqual([`Bearer ${successor}`])
    expect(requests.slice(2)).toEqual([
      '/api/claude_cli/bootstrap',
      '/v1/messages',
    ])
  } finally {
    clock.mockRestore()
  }
})

test('Pi classifies an exhausted account read as retryable and keeps the last snapshot', async () => {
  const native = getPiNativeRuntime(storagePath)
  const runtime = await native.service()
  const commands = createPiNativeCommands(storagePath)
  const status = await commands.readStatus('account', {})
  expect(status).toContain('main:')
  const before = runtime.peek?.()
  expect(before).toBeDefined()
  const failure = spyOn(runtime, 'read').mockRejectedValue(
    new NativeTransientAccountError('pool-read'),
  )
  let sends = 0
  const records: LogTestRecord[] = []
  const level = getLogLevel()
  setLogLevel('warn')
  __setLogTestSink((record) => records.push(record))
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    expect(await commands.readStatus('account', {})).toBe(status)
    expect(await commands.readStatus('account', {})).toBe(status)
    expect(
      records.filter((record) =>
        record.message.includes('keeping status display'),
      ),
    ).toHaveLength(1)
    const result = await streamCortexKitAnthropic(model, context).result()
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(true)
    expect(failure).toHaveBeenCalled()
    expect(runtime.peek?.()).toBe(before)
    expect(sends).toBe(0)
  } finally {
    __setLogTestSink(null)
    setLogLevel(level)
    failure.mockRestore()
  }
})

test('Pi abort ends a stalled quota preflight without sending a model request', async () => {
  await saveNativePiFixture(
    {
      version: 1,
      routing: { mode: 'sticky-balanced' },
      accounts: [],
    },
    storagePath,
    { mainAccess: 'sk-ant-oat01-synthetic-native-main-access' },
  )
  getPiNativeRuntime(storagePath, {
    local: {
      resolveIdentity: async () =>
        getClaudeCodeIdentityForVerifiedAccount(
          'main',
          fixtureAccountIdentity('main'),
        ),
    },
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: (response: Response) => void
  const quota = new Promise<Response>((resolve) => {
    release = resolve
  })
  let sends = 0
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('/api/oauth/usage')) {
        entered()
        return quota
      }
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const controller = new AbortController()
  const pending = streamCortexKitAnthropic(model, context, {
    signal: controller.signal,
    sessionId: 'synthetic-quota-abort',
  }).result()
  try {
    await Promise.race([
      started,
      pending.then((result) => {
        throw new Error(
          `Quota preflight was not reached: ${result.errorMessage ?? result.stopReason}`,
        )
      }),
    ])
    controller.abort(new Error('synthetic caller timeout'))
    const result = await Promise.race([
      pending,
      Bun.sleep(500).then(() => undefined),
    ])
    expect(result?.stopReason).toBe('aborted')
    expect(result?.errorMessage).toBe('synthetic caller timeout')
  } finally {
    release(
      Response.json({
        seven_day: {
          utilization: 0,
          resets_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    )
    await pending
    await closePiNativeRuntime(storagePath)
  }
  expect(sends).toBe(0)
})

test('Pi ready replies do not wait for header quota to merge with the last poll', async () => {
  const checkedAt = Date.now() - 60_000
  const resetAt = Math.floor(Date.now() / 1_000) + 3_600
  const weekly = { usedPercent: 22, remainingPercent: 78, checkedAt }
  const scoped = [{ ...weekly, id: 'opus', title: 'Opus', modelName: 'Opus' }]
  const extraUsage = {
    used: { amountMinor: 100, currency: 'USD', exponent: 2 },
    limit: { amountMinor: 500, currency: 'USD', exponent: 2 },
    utilizationPercent: 20,
    exhausted: false,
  }
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      quota: {
        enabled: false,
        mainQuota: {
          source: 'poll',
          checkedAt,
          five_hour: { usedPercent: 5, remainingPercent: 95, checkedAt },
          seven_day: weekly,
          scoped,
          extraUsage,
        },
      },
    },
    storagePath,
  )
  const native = getPiNativeRuntime(storagePath)
  const runtime = await native.service()
  const publishLocal = runtime.publishLocal.bind(runtime)
  const started = Promise.withResolvers<void>()
  const unblock = Promise.withResolvers<void>()
  const publication = spyOn(runtime, 'publishLocal').mockImplementation(
    async (subject, patch, signal) => {
      if (patch.quota?.source === 'headers') {
        started.resolve()
        await unblock.promise
      }
      return publishLocal(subject, patch, signal)
    },
  )
  globalThis.fetch = Object.assign(
    async () => {
      const response = success()
      response.headers.set('anthropic-ratelimit-unified-5h-utilization', '.39')
      response.headers.set(
        'anthropic-ratelimit-unified-5h-reset',
        String(resetAt),
      )
      return response
    },
    { preconnect: originalFetch.preconnect },
  )

  const pending = streamCortexKitAnthropic(model, context).result()
  try {
    const result = await Promise.race([
      pending,
      started.promise.then(() => Bun.sleep(1_000)).then(() => undefined),
    ])
    expect(result?.stopReason).toBe('stop')
  } finally {
    unblock.resolve()
    await pending
    await native.usagePublications.drain()
    publication.mockRestore()
  }
  const snapshot = await runtime.read()
  expect(
    snapshot.accounts.find((account) => account.id === 'main')?.quota,
  ).toMatchObject({
    source: 'headers',
    checkedAt,
    five_hour: {
      usedPercent: 39,
      remainingPercent: 61,
      resetsAt: new Date(resetAt * 1_000).toISOString(),
    },
    seven_day: weekly,
    scoped,
    extraUsage,
  })
})

test('Pi empty-init routing uses the construction-time override or native derived path; missing authority refuses', () =>
  trackPiTestBody(
    (async () => {
      const lifetime = new TestLifetime()
      try {
        await lifetime.runBody(async () => {
          const root = await mkdtemp(join(tmpdir(), 'pi-empty-init-routing-'))
          const original = process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
          const originalState = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
          const runtimes: PiNativeRuntime[] = []
          lifetime.deferCleanup(async () => {
            await Promise.allSettled(runtimes.map((runtime) => runtime.close()))
            if (original === undefined)
              delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
            else process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = original
            if (originalState === undefined)
              delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
            else process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = originalState
            await rm(root, { recursive: true, force: true })
          })
          for (const override of [
            undefined,
            join(root, 'override-routing.json'),
          ]) {
            if (override === undefined)
              delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
            else process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = override
            process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
              root,
              override ? 'override-state.json' : 'derived-state.json',
            )
            const env = { ...process.env }
            const paths = await resolveNativePoolPaths(
              join(root, override ? 'override.json' : 'derived.json'),
            )
            await writeFile(
              paths.journal,
              JSON.stringify({
                version: 5,
                kind: 'empty-init',
                storageId: paths.storageId,
                host: 'opencode',
                phase: 'committed',
              }),
              { mode: 0o600 },
            )
            const runtime = new PiNativeRuntime(paths.legacyConfig, {
              vaultPoll: { intervalMs: 0 },
            })
            runtimes.push(runtime)
            process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
              root,
              'changed-after-construction.json',
            )
            expect(await runtime.routingStorage()).toEqual({
              path: override ?? getStickyRoutingStatePath(paths.config),
            })
            expect(await runtime.routingPath()).toBe(
              resolveLocalRoutingDestination('pi', paths, env),
            )
            await rm(paths.journal)
            await expect(runtime.routingStorage()).rejects.toMatchObject({
              name: 'NativeAuthorityError',
              code: 'migration-required',
            })
          }
        })
      } finally {
        await lifetime.finish()
      }
    })(),
  ))

for (const concurrency of [4, 8]) {
  test(`Pi concurrent local sends retain lastUsed N=${concurrency}`, () =>
    trackPiTestBody(
      (async () => {
        const locks: string[] = []
        getPiNativeRuntime(storagePath, {
          local: {
            onLockEvent: (event) => {
              if (event.type === 'acquired') locks.push(event.name)
            },
          },
        })
        globalThis.fetch = Object.assign(async () => success(), {
          preconnect: originalFetch.preconnect,
        })
        const records: LogTestRecord[] = []
        const previous = getLogLevel()
        setLogLevel('debug')
        __setLogTestSink((record) => records.push(record))
        try {
          const start = Date.now()
          const replies = await Promise.all(
            Array.from({ length: concurrency }, () =>
              streamCortexKitAnthropic(model, context, {
                apiKey: 'synthetic-host-access',
              }).result(),
            ),
          )
          expect(replies.every((reply) => reply.stopReason === 'stop')).toBe(
            true,
          )
          await closePiNativeRuntime(storagePath)
          const runtime = createNativeAccountRuntime({
            paths: await resolveNativePoolPaths(storagePath),
            host: 'pi',
          })
          try {
            expect(
              (await runtime.read()).accounts.find(
                (account) => account.id === 'main',
              )?.lastUsed,
            ).toBeGreaterThanOrEqual(start)
          } finally {
            await runtime.close()
          }
          const dropped = records.filter(
            (record) =>
              record.message === 'Account usage publication unavailable',
          ).length
          const contention = records.filter((record) =>
            JSON.stringify(record.payload ?? {}).includes(
              'LockContentionError',
            ),
          ).length
          console.log(
            `local Pi N=${concurrency}: dropped=${dropped} LockContentionError=${contention} pool-config=${locks.filter((name) => name === 'pool-config').length} native-runtime=${locks.filter((name) => name === 'native-runtime').length}`,
          )
          expect(dropped).toBe(0)
          expect(contention).toBe(0)
        } finally {
          __setLogTestSink(null)
          setLogLevel(previous)
        }
      })(),
    ))
}

test('native Pi serving ignores host and legacy OAuth material after committed migration', () =>
  trackPiTestBody(
    (async () => {
      await writeFile(
        storagePath,
        JSON.stringify({
          version: 1,
          claustrum: { mode: 'claustrum' },
          accounts: [
            {
              type: 'oauth',
              id: 'legacy-rescue',
              access: 'synthetic-legacy-access',
              refresh: 'synthetic-legacy-refresh',
              expires: Date.now() + 3_600_000,
            },
          ],
        }),
        { mode: 0o600 },
      )
      const sent: string[] = []
      globalThis.fetch = Object.assign(
        async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          sent.push(new Headers(init?.headers).get('authorization') ?? '')
          return success()
        },
        { preconnect: originalFetch.preconnect },
      )
      expect(
        (
          await streamCortexKitAnthropic(model, context, {
            apiKey: 'synthetic-host-access',
          }).result()
        ).stopReason,
      ).toBe('stop')
      expect(sent).toEqual(['Bearer sk-ant-oat01-synthetic-native-main-access'])
      expect(await readFile(storagePath, 'utf8')).toContain(
        'synthetic-legacy-access',
      )
    })(),
  ))

test.each(['missing', 'building', 'malformed'] as const)(
  'native Pi authority %s refuses before any physical dispatch and cannot use a paid key',
  (authority) =>
    trackPiTestBody(
      (async () => {
        const paths = await resolveNativePoolPaths(storagePath)
        if (authority === 'missing') await rm(paths.journal)
        else if (authority === 'malformed')
          await writeFile(paths.journal, '{broken', { mode: 0o600 })
        else {
          const journal = JSON.parse(
            await readFile(paths.journal, 'utf8'),
          ) as Record<string, unknown>
          await writeFile(
            paths.journal,
            JSON.stringify({
              ...journal,
              phase: 'building',
              expectedHostAuth: 'unprepared',
              expectedRouting: 'unprepared',
            }),
            { mode: 0o600 },
          )
        }
        let sends = 0
        globalThis.fetch = Object.assign(
          async () => {
            sends++
            return success()
          },
          { preconnect: originalFetch.preconnect },
        )
        expect(
          (
            await streamCortexKitAnthropic(model, context, {
              apiKey: 'synthetic-host-access',
            }).result()
          ).stopReason,
        ).toBe('error')
        expect(sends).toBe(0)
      })(),
    ),
)

test('native Pi serving refuses leftover host OAuth without deleting it or dispatching', () =>
  trackPiTestBody(
    (async () => {
      const authPath = join(directory, 'auth.json')
      const auth = JSON.stringify({
        anthropic: {
          type: 'oauth',
          access: 'synthetic-host-access',
          refresh: 'synthetic-host-refresh',
          expires: Date.now() + 3_600_000,
        },
      })
      await writeFile(authPath, auth, { mode: 0o600 })
      let sends = 0
      globalThis.fetch = Object.assign(
        async () => {
          sends++
          return success()
        },
        { preconnect: originalFetch.preconnect },
      )
      const result = await streamCortexKitAnthropic(model, context, {
        apiKey: 'synthetic-host-access',
      }).result()
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toContain('offline setup')
      expect(sends).toBe(0)
      expect(await readFile(authPath, 'utf8')).toBe(auth)
    })(),
  ))

test.each([
  { name: 'general exhaustion', status: 429, utilization: 100, paid: true },
  {
    name: 'model-scope exhaustion only',
    status: 429,
    utilization: 10,
    paid: false,
  },
  {
    name: 'authentication failure',
    status: 401,
    utilization: 100,
    paid: false,
  },
  { name: 'server failure', status: 500, utilization: 100, paid: false },
])(
  'native Pi paid fallback requires confirmed general OAuth exhaustion: $name',
  (scenario) =>
    trackPiTestBody(
      (async () => {
        const modelRequests: string[] = []
        globalThis.fetch = Object.assign(
          async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            const url = String(input)
            if (url.includes('/api/oauth/usage'))
              return new Response(
                JSON.stringify({
                  five_hour: { utilization: scenario.utilization },
                  seven_day: { utilization: scenario.utilization },
                  limits: [
                    {
                      kind: 'weekly_scoped',
                      group: 'weekly',
                      percent: 100,
                      scope: { model: { display_name: 'Fable' } },
                    },
                  ],
                }),
              )
            if (!url.includes('/v1/messages'))
              return new Response('{}', { status: 503 })
            const authorization =
              new Headers(init?.headers).get('authorization') ?? ''
            modelRequests.push(authorization)
            return url.startsWith('https://paid.invalid')
              ? success()
              : new Response('primary refused', { status: scenario.status })
          },
          { preconnect: originalFetch.preconnect },
        )
        const result = await streamCortexKitAnthropic(model, context, {
          apiKey: 'synthetic-host-access',
        }).result()
        expect(result.stopReason).toBe(scenario.paid ? 'stop' : 'error')
        expect(modelRequests).toEqual(
          scenario.paid
            ? [
                'Bearer sk-ant-oat01-synthetic-native-main-access',
                'Bearer synthetic-native-paid-key',
              ]
            : ['Bearer sk-ant-oat01-synthetic-native-main-access'],
        )
      })(),
    ),
)

test('offline controller imports synthetic Pi host OAuth with consent before native serving', () =>
  trackPiTestBody(
    (async () => {
      const root = join(directory, 'host-import')
      await mkdir(root, { recursive: true, mode: 0o700 })
      storagePath = join(root, 'anthropic-auth.json')
      process.env.PI_CODING_AGENT_DIR = root
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
        root,
        'anthropic-auth-state.json',
      )
      const paths = await resolveNativePoolPaths(storagePath)
      const hostAuthPath = join(root, 'auth.json')
      await writeFile(
        hostAuthPath,
        JSON.stringify({
          anthropic: {
            type: 'oauth',
            access: 'sk-ant-oat01-synthetic-imported-host-access',
            refresh: 'synthetic-imported-host-refresh',
            expires: Date.now() + 3_600_000,
          },
          other: { type: 'api_key', key: 'synthetic-other-provider-key' },
        }),
        { mode: 0o600 },
      )
      let fences = 0
      const journal = await runNativeMigration({
        paths,
        host: 'pi',
        hostAuthPath,
        env: {},
        removePiAnthropicAuth: true,
        routingSourcePath: join(root, 'legacy-routing.json'),
        routingDestinationPath: join(root, 'native-routing.json'),
        processFence: async () => {
          fences++
        },
      })
      expect(journal.version).toBe(4)
      expect(journal.phase).toBe('retired')
      expect(fences).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(hostAuthPath, 'utf8'))).toEqual({
        other: { type: 'api_key', key: 'synthetic-other-provider-key' },
      })
      const validator = createNativeAccountRuntime({
        paths,
        host: 'pi',
        local: {
          refreshToken: async () => ({
            access: 'sk-ant-oat01-synthetic-imported-native-access',
            refresh: 'synthetic-imported-native-refresh',
            expires: Date.now() + 3_600_000,
            expiresIn: 3600,
          }),
          resolveIdentity: async () =>
            getClaudeCodeIdentityForVerifiedAccount(
              'main',
              fixtureAccountIdentity('imported-main'),
            ),
        },
      })
      try {
        expect((await validator.authorizeLocal('main')).status).toBe('usable')
      } finally {
        validator.close()
      }
      const sent: string[] = []
      globalThis.fetch = Object.assign(
        async (
          _input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          sent.push(new Headers(init?.headers).get('authorization') ?? '')
          return success()
        },
        { preconnect: originalFetch.preconnect },
      )
      expect(
        (
          await streamCortexKitAnthropic(model, context, {
            apiKey: 'sk-ant-oat01-synthetic-imported-host-access',
          }).result()
        ).stopReason,
      ).toBe('stop')
      expect(sent).toEqual([
        'Bearer sk-ant-oat01-synthetic-imported-native-access',
      ])
    })(),
  ))

test('a local 401 retry held at response cancellation refuses a newly hosted marker before physical resend', () =>
  trackPiTestBody(
    (async () => {
      let cancelling = () => {}
      let release = () => {}
      const cancelled = new Promise<void>((resolve) => {
        cancelling = resolve
      })
      const resume = new Promise<void>((resolve) => {
        release = resolve
      })
      const sent: string[] = []
      let exchanges = 0
      getPiNativeRuntime(storagePath, {
        local: {
          refreshToken: async () => {
            exchanges++
            return {
              access: 'sk-ant-oat01-synthetic-native-retry',
              refresh: 'synthetic-native-retry-refresh',
              expires: Date.now() + 3_600_000,
              expiresIn: 3600,
            }
          },
          resolveIdentity: async () =>
            getClaudeCodeIdentityForVerifiedAccount(
              'main',
              fixtureAccountIdentity('main'),
            ),
        },
      })
      globalThis.fetch = Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url = String(input)
          if (!url.includes('/v1/messages'))
            return Response.json({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            })
          sent.push(new Headers(init?.headers).get('authorization') ?? '')
          if (sent.length > 1) return success()
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    '{"error":{"type":"authentication_error","message":"synthetic rejection"}}',
                  ),
                )
              },
              cancel() {
                cancelling()
                return resume
              },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        },
        { preconnect: originalFetch.preconnect },
      )
      const pending = streamCortexKitAnthropic(model, context, {
        apiKey: 'synthetic-host-access',
      }).result()
      const settled = Promise.allSettled([pending])
      try {
        await Promise.race([
          cancelled,
          pending.then(() => {
            throw new Error('request completed before cancellation barrier')
          }),
        ])
        expect(exchanges).toBe(1)
        process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
        release()
        expect((await pending).stopReason).toBe('error')
        expect(sent).toEqual([
          'Bearer sk-ant-oat01-synthetic-native-main-access',
        ])
      } finally {
        release()
        await settled
        delete process.env.CORTEXKIT_VAULT_HOST
      }
    })(),
  ))
