import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  getClaudeCodeIdentityForVerifiedAccount,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { closePiNativeRuntime } from '../native.ts'
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
    { mainAccess: 'synthetic-native-main-access' },
  )
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  closePiNativeRuntime(storagePath)
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  await rm(directory, { recursive: true, force: true })
})

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
      expect(sent).toEqual(['Bearer synthetic-native-main-access'])
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
                'Bearer synthetic-native-main-access',
                'Bearer synthetic-native-paid-key',
              ]
            : ['Bearer synthetic-native-main-access'],
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
            access: 'synthetic-imported-host-access',
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
      expect(journal.version).toBe(3)
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
            access: 'synthetic-imported-native-access',
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
            apiKey: 'synthetic-imported-host-access',
          }).result()
        ).stopReason,
      ).toBe('stop')
      expect(sent).toEqual(['Bearer synthetic-imported-native-access'])
    })(),
  ))
