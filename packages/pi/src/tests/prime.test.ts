import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  type AccountStorage,
  PrimeManager,
  primeAccountMarkerDir,
  primeMarkerPath,
  resolveNativePoolPaths,
  signRequestBody,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import cortexKitPiAnthropicAuth from '../index.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import { getPiTrackedCacheKeepSessions } from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const originalFetch = globalThis.fetch
const envKeys = [
  'PI_CODING_AGENT_DIR',
  'PI_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
]
let previousEnv: Array<string | undefined>
let directory: string
let storagePath: string
let markerDir: string
let now: number
let sends: Array<{ headers: Headers; text: string }>
let polls: number
let quotaResponse: () => Promise<Response>
const intervals = new Set<ReturnType<typeof setInterval>>()
const timeouts = new Map<
  ReturnType<typeof setTimeout>,
  { callback: () => void; ms?: number }
>()
const schedule = ((_callback: () => void) => {
  const timer = { unref() {} } as ReturnType<typeof setInterval>
  intervals.add(timer)
  return timer
}) as typeof setInterval
const cancel = ((timer: ReturnType<typeof setInterval>) => {
  intervals.delete(timer)
}) as typeof clearInterval
const later = ((callback: () => void, ms?: number) => {
  const timer = { unref() {} } as ReturnType<typeof setTimeout>
  timeouts.set(timer, { callback, ms })
  return timer
}) as typeof setTimeout
const cancelLater = ((timer: ReturnType<typeof setTimeout>) => {
  timeouts.delete(timer)
}) as typeof clearTimeout

function quota(remaining = 100) {
  return {
    five_hour: {
      utilization: 100 - remaining,
      resets_at: new Date(now - 120_000).toISOString(),
    },
    seven_day: {
      utilization: 0,
      resets_at: new Date(now + 604_800_000).toISOString(),
    },
  }
}

beforeEach(async () => {
  previousEnv = envKeys.map((key) => process.env[key])
  directory = await mkdtemp(join(tmpdir(), 'pi-prime-'))
  storagePath = join(directory, 'accounts.json')
  markerDir = join(directory, 'markers')
  await mkdir(markerDir)
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  now = Date.now()
  sends = []
  polls = 0
  quotaResponse = async () => Response.json(quota())
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init)
      if (request.url.includes('/api/oauth/usage')) {
        polls++
        return quotaResponse()
      }
      expect(request.url).toBe(
        'https://api.anthropic.com/v1/messages?beta=true',
      )
      expect(request.redirect).toBe('error')
      const bytes = Buffer.from(await request.arrayBuffer())
      sends.push({
        headers: request.headers,
        text: (request.headers.get('content-encoding') === 'gzip'
          ? gunzipSync(bytes)
          : bytes
        ).toString(),
      })
      return Response.json({ usage: { input_tokens: 17, output_tokens: 1 } })
    },
    { preconnect: originalFetch.preconnect },
  )
})

afterEach(async () => {
  await closePiNativeRuntime(storagePath)
  globalThis.fetch = originalFetch
  envKeys.forEach((key, index) => {
    const value = previousEnv[index]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  intervals.clear()
  timeouts.clear()
  await rm(directory, { recursive: true, force: true })
})

async function fixture(enabled = true, extra: Partial<AccountStorage> = {}) {
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled },
      quota: {
        enabled: true,
        mainQuota: {
          source: 'poll',
          checkedAt: now,
          five_hour: {
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: now,
            resetsAt: new Date(now - 120_000).toISOString(),
          },
        },
      },
      ...extra,
    },
    storagePath,
  )
  const native = getPiNativeRuntime(storagePath, {
    vaultPoll: { intervalMs: 0 },
    prime: {
      markerDir,
      now: () => now,
      setIntervalImpl: schedule,
      clearIntervalImpl: cancel,
      setTimeoutImpl: later,
      clearTimeoutImpl: cancelLater,
    },
  })
  await native.service()
  return native
}

test('Pi Prime enabled with a due account fires once through the signed model transport', async () => {
  const native = await fixture()
  const identity = (await native.view()).accounts.find(
    (row) => row.id === 'main',
  )?.accountIdentity
  expect(identity).toBeString()
  expect(await native.prime?.manager.options.getAccountIdentity?.('main')).toBe(
    identity,
  )
  await native.prime?.manager.tick()
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(1)
  expect(polls).toBe(1)
  const sent = sends[0]!
  const body = JSON.parse(sent.text)
  expect(body).toMatchObject({
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: '0' }],
  })
  expect(body.system).toContainEqual({
    type: 'text',
    text: 'Reply with 1 when you receive 0.',
  })
  expect(body.system[0].text).toContain('x-anthropic-billing-header:')
  expect(body.system[0].text).not.toContain('cch=00000')
  expect(await signRequestBody(sent.text)).toBe(sent.text)
  expect(body.stream).toBeUndefined()
  expect(body.cache_control).toBeUndefined()
  expect(body.metadata.user_id).toBeString()
  expect(sent.headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-main-access',
  )
  expect(sent.headers.get('x-api-key')).toBeNull()
  expect(sent.headers.get('x-claude-code-request-class')).toBe('auxiliary')
  expect(await getPiTrackedCacheKeepSessions()).toEqual([])
  const status = await createPiNativeCommands(storagePath).readStatus(
    'prime',
    {},
  )
  expect(status).toContain('next prime')
  expect(status).toContain('primed')
  expect(status).toContain('1 prime')
  expect(
    (await native.view()).accounts.find((row) => row.id === 'main')?.prime,
  ).toMatchObject({ count: 1, inputTokens: 17, outputTokens: 1 })
  expect([...timeouts.values()].map((timer) => timer.ms)).toEqual([90_000])
})

test('Pi Prime disabled never polls or sends, and the menu enables it live', async () => {
  const native = await fixture(false)
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(0)
  expect(polls).toBe(0)
  expect(await readdir(markerDir, { recursive: true })).toEqual([])
  await createPiNativeCommands(storagePath).dispatch(
    { action: 'prime-on', values: {} },
    {},
  )
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(1)
})

test('Pi Prime toggling off during the fresh quota check aborts before claim or send', async () => {
  const native = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  quotaResponse = async () => {
    entered()
    await gate
    return Response.json(quota())
  }
  const tick = native.prime!.manager.tick()
  try {
    await started
    await createPiNativeCommands(storagePath).dispatch(
      { action: 'prime-off', values: {} },
      {},
    )
  } finally {
    release()
    await tick
  }
  expect(sends).toHaveLength(0)
  expect(await readdir(markerDir, { recursive: true })).toEqual([])
})

test('Pi Prime toggling off during model authorization aborts before physical send', async () => {
  const native = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const authorize = native.authorize.bind(native)
  const spy = spyOn(native, 'authorize').mockImplementation(async (...args) => {
    const admitted = await authorize(...args)
    entered()
    await gate
    return admitted
  })
  const tick = native.prime!.manager.tick()
  try {
    await started
    await createPiNativeCommands(storagePath).dispatch(
      { action: 'prime-off', values: {} },
      {},
    )
  } finally {
    release()
    await tick
    spy.mockRestore()
  }
  expect(sends).toHaveLength(0)
})

test('Pi Prime fresh quota below the killswitch floor does not claim or fire', async () => {
  const native = await fixture(true, {
    killswitch: { enabled: true, main: { five_hour: 10 } },
  })
  quotaResponse = async () => Response.json(quota(5))
  await native.prime?.manager.tick()
  expect(polls).toBe(1)
  expect(sends).toHaveLength(0)
  expect(await readdir(markerDir, { recursive: true })).toEqual([])
})

test('Pi Prime and an OC2-style manager sharing account storage claim only one send', async () => {
  const native = await fixture()
  const runtime = await native.service()
  const paths = await resolveNativePoolPaths(storagePath)
  let oc2Sends = 0
  const fingerprint = async (accountId: string) => {
    const credential = await runtime.authorizeLocal(accountId)
    if (credential.status !== 'usable') return undefined
    const lineage = await runtime.getOrCreateAuthLineage(
      accountId,
      credential.subject,
    )
    return lineage ? tokenFingerprint(lineage) : undefined
  }
  const oc2 = new PrimeManager({
    storagePath: paths.legacyConfig,
    markerDir,
    now: () => now,
    loadStorage: async () => (await runtime.read()).policyStorage,
    getAccountFingerprint: fingerprint,
    refreshQuota: async () => ({
      quota: await runtime.fetchQuota('main'),
      fresh: true,
    }),
    sendPrime: async () => {
      oc2Sends++
      return {
        ok: true,
        status: 200,
        ms: 1,
        usage: { inputTokens: 17, outputTokens: 1 },
      }
    },
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 17,
      outputTokens: 1,
      since: now,
    }),
  })
  try {
    await Promise.all([native.prime!.manager.tick(), oc2.tick()])
    expect(sends.length + oc2Sends).toBe(1)
    const accountDir = primeAccountMarkerDir(
      markerDir,
      paths.legacyConfig,
      (await fingerprint('main'))!,
    )
    const marker = primeMarkerPath(accountDir, 'main', now - 120_000)
    expect(await Bun.file(marker).exists()).toBe(true)
  } finally {
    oc2.stop()
  }
})

test('Pi Prime owns one interval per storage and runtime close stops its timers', async () => {
  const native = await fixture()
  expect(getPiNativeRuntime(storagePath)).toBe(native)
  expect(intervals.size).toBe(1)
  await native.prime?.manager.tick()
  expect(timeouts.size).toBe(1)
  await closePiNativeRuntime(storagePath)
  expect(intervals.size).toBe(0)
  expect(timeouts.size).toBe(0)
  expect(native.prime?.manager.isStopped()).toBe(true)
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(1)
})

test('Pi Prime stops on the extension session_shutdown event', async () => {
  const native = await fixture()
  const handlers = new Map<string, unknown>()
  await cortexKitPiAnthropicAuth({
    on: (name: string, callback: unknown) => {
      handlers.set(name, callback)
    },
    registerCommand() {},
    registerProvider() {},
  } as unknown as ExtensionAPI)
  const shutdown = handlers.get('session_shutdown') as (
    event: unknown,
    context: unknown,
  ) => Promise<void>
  await shutdown(
    {},
    { sessionManager: { getSessionId: () => 'prime-shutdown' } },
  )
  expect(native.prime?.manager.isStopped()).toBe(true)
  expect(intervals.size).toBe(0)
  await native.prime?.manager.tick()
  expect(sends).toHaveLength(0)
})
