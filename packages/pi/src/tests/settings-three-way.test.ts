import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AccountSettingsReaderInput,
  NativeAccountSnapshot,
  ThreeWayBoolean,
} from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import {
  __piRequestPolicyForTest,
  closePiNativeRuntime,
  getPiNativeRuntime,
} from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import {
  __getPiRoutingServicesForTest,
  __sendPiAnthropicRequestForTest,
  stopPiCacheKeep,
} from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const cases = [
  { value: true, cache: true, quota: true },
  { value: false, cache: false, quota: false },
  { value: undefined, cache: false, quota: true },
  { value: 'on', cache: true, quota: true },
  { value: 'off', cache: false, quota: false },
  { value: 'default', cache: false, quota: true },
] as const

const model: Model<Api> = {
  id: 'claude-fable-5',
  name: 'Claude Fable 5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}

const envKeys = [
  'PI_ANTHROPIC_AUTH_FILE',
  'PI_CODING_AGENT_DIR',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
] as const
let originalEnv: (string | undefined)[]
let directory: string
let storagePath: string
let snapshot: NativeAccountSnapshot
let readSpy: ReturnType<typeof spyOn> | undefined

beforeEach(async () => {
  originalEnv = envKeys.map((key) => process.env[key])
  directory = await mkdtemp(join(tmpdir(), 'pi-three-way-'))
  storagePath = join(directory, 'anthropic-auth.json')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    directory,
    'cachekeep',
  )
  process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
    directory,
    'routing.json',
  )
  const now = Date.now()
  await saveNativePiFixture(
    {
      version: 1,
      quota: { enabled: false },
      accounts: [
        {
          id: 'fallback',
          type: 'oauth',
          access: 'sk-ant-oat01-three-way-fallback',
          refresh: 'three-way-fallback-refresh',
          expires: now + 3_600_000,
          quota: {
            checkedAt: now,
            five_hour: {
              remainingPercent: 10,
              usedPercent: 90,
              checkedAt: now,
            },
            seven_day: {
              remainingPercent: 10,
              usedPercent: 90,
              checkedAt: now,
            },
          },
        },
      ],
    },
    storagePath,
  )
  const runtime = await getPiNativeRuntime(storagePath).service()
  snapshot = await runtime.read()
  readSpy = spyOn(runtime, 'read').mockImplementation(async () => snapshot)
})

afterEach(async () => {
  readSpy?.mockRestore()
  readSpy = undefined
  await stopPiCacheKeep()
  await closePiNativeRuntime(storagePath)
  await rm(directory, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    const value = originalEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

function setField(
  section: 'claudeCache' | 'quota',
  value: ThreeWayBoolean | undefined,
) {
  const storage: AccountSettingsReaderInput = {
    ...snapshot.policyStorage,
    ...(section === 'claudeCache'
      ? {
          claudeCache: {
            mode: 'explicit',
            ...(value !== undefined && { enabled: value }),
          },
        }
      : {
          quota: {
            minimumRemaining: { five_hour: 50, seven_day: 50 },
            ...(value !== undefined && { enabled: value }),
          },
        }),
  }
  // The account-store type remains boolean-only. Inject file-mode enum values
  // at the in-memory reader boundary without writing them to the account store.
  snapshot = {
    ...snapshot,
    policyStorage: storage as NativeAccountSnapshot['policyStorage'],
  }
}

test('claude_cache_enabled: sendAnthropicRequest preserves legacy inputs and reads on/off/default', async () => {
  for (const { value, cache } of cases) {
    setField('claudeCache', value)
    const bodies: string[] = []
    const response = await __sendPiAnthropicRequestForTest(
      { model, context, storagePath },
      {
        native: getPiNativeRuntime(storagePath),
        fetch: (async (_input, init) => {
          bodies.push(String(init?.body))
          return new Response('{}', { status: 200 })
        }) as typeof fetch,
      },
    )
    expect(response.status, String(value)).toBe(200)
    expect(bodies).toHaveLength(1)
    const ttls: unknown[] = []
    JSON.stringify(JSON.parse(bodies[0]!), (key, entry) => {
      if (key === 'cache_control') ttls.push(entry.ttl)
      return entry
    })
    expect(ttls.length, String(value)).toBeGreaterThan(0)
    expect([...new Set(ttls)], String(value)).toEqual([
      cache ? '1h' : undefined,
    ])
    await response.body?.cancel()
  }
})

test('claude_cache_enabled: createPiNativeCommands status cache preserves legacy inputs and reads on/off/default', async () => {
  const backend = createPiNativeCommands(storagePath)
  const runtime = await getPiNativeRuntime(storagePath).service()
  const settingsPath = await runtime.getSettingsPath()
  for (const { value, cache } of cases) {
    setField('claudeCache', value)
    expect(await backend.readStatus('cache', {}), String(value)).toBe(
      `1-hour cache: ${cache ? 'enabled' : 'disabled'}; mode: explicit\n- Persisted: ${settingsPath}`,
    )
  }
})

test('quota_enabled: requestPolicy preserves legacy inputs and reads on/off/default', () => {
  const account = snapshot.accounts.find((entry) => entry.id === 'fallback')!
  const policy = __piRequestPolicyForTest('fallback', model.id)
  for (const { value, quota } of cases) {
    setField('quota', value)
    expect(policy(account, snapshot), String(value)).toEqual(
      quota
        ? { status: 'blocked', reason: 'quota-ineligible' }
        : { status: 'allowed' },
    )
  }
})

test('quota_enabled: getPiRoutingServices getUsableFallbackAccounts preserves legacy inputs and reads on/off/default', async () => {
  const { quotaManager, getUsableFallbackAccounts } =
    __getPiRoutingServicesForTest(storagePath, snapshot)
  const accounts = snapshot.policyStorage.accounts.filter(
    (account) => account.type === 'oauth',
  )
  quotaManager.seedFallbacksFromAccounts(accounts)
  for (const { value, quota } of cases) {
    setField('quota', value)
    const eligible = await getUsableFallbackAccounts(snapshot.policyStorage, {
      modelId: model.id,
    })
    expect(
      eligible.map((account) => account.id),
      String(value),
    ).toEqual(quota ? [] : ['fallback'])
  }
})
