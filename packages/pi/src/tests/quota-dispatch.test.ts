import { expect, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { resolveNativePoolPaths } from '@cortexkit/anthropic-auth-core'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'

// Quota metadata stages beside the runtime file as
// "<runtime>.native-runtime-metadata.*"; other runtime writes use
// "<runtime>.native-runtime.*". Compare names, since the metadata writer
// resolves the folder's canonical path first.
function isRuntimeStage(path: string, runtime: string) {
  return basename(path).startsWith(`${basename(runtime)}.native-runtime`)
}


const { test, deferCleanup, gate, trackDetached } = createTestLifetimeSuite()

test('Pi paces physical usage GETs for two due fallback accounts before a single model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-physical-quota-dispatch-'))
  const storagePath = join(root, 'anthropic-auth.json')
  const originalFetch = globalThis.fetch
  const previous = [
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_CODING_AGENT_DIR',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ].map((name) => [name, process.env[name]] as const)
  deferCleanup(async () => {
    await closePiNativeRuntime(storagePath)
    globalThis.fetch = originalFetch
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  const accesses = ['sk-ant-oat01-paced-first', 'sk-ant-oat01-paced-second']
  await saveNativePiFixture(
    {
      version: 1,
      routing: { mode: 'fallback-first' },
      quota: {
        enabled: true,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
      },
      accounts: accesses.map((access, index) => ({
        id: `paced-${index}`,
        type: 'oauth',
        enabled: true,
        access,
        refresh: `synthetic-paced-refresh-${index}`,
        expires: Date.now() + 5 * 3_600_000,
      })),
    },
    storagePath,
  )
  const upstream: Array<{ method: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      upstream.push({
        method: request.method,
        authorization: request.headers.get('authorization'),
      })
      return Response.json({
        five_hour: { utilization: 4 },
        seven_day: { utilization: 13 },
      })
    },
  })
  deferCleanup(() => server.stop(true))
  const starts: number[] = []
  const modelAuthorizations: Array<string | null> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith('/api/oauth/usage')) {
        starts.push(performance.now())
        return originalFetch(server.url, init)
      }
      if (url.includes('/v1/messages')) {
        modelAuthorizations.push(
          new Headers(init?.headers).get('authorization'),
        )
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        )
      }
      throw new Error('Unexpected provider fixture request')
    },
    { preconnect: originalFetch.preconnect },
  )
  const model: Model<Api> = {
    id: 'claude-fable-5',
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
  const stream = streamCortexKitAnthropic(model, context, {
    apiKey: 'sk-ant-oat01-main-access',
    sessionId: 'pi-paced-fallback-quota',
  })
  const result = await stream.result()
  expect(result.stopReason).toBe('stop')
  expect(upstream).toEqual(
    accesses.map((access) => ({
      method: 'GET',
      authorization: `Bearer ${access}`,
    })),
  )
  expect(starts).toHaveLength(2)
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_000)
  expect(modelAuthorizations).toEqual([`Bearer ${accesses[0]}`])
})

test('Pi serves a pending poll reading without waiting for runtime sync and close drains it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-pending-quota-'))
  const storagePath = join(root, 'anthropic-auth.json')
  const originalFetch = globalThis.fetch
  const previous = [
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_CODING_AGENT_DIR',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ].map((name) => [name, process.env[name]] as const)
  deferCleanup(async () => {
    await closePiNativeRuntime(storagePath)
    globalThis.fetch = originalFetch
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture(
    {
      version: 1,
      routing: { mode: 'fallback-first' },
      quota: { enabled: true },
      killswitch: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accounts: [
        {
          id: 'pending',
          type: 'oauth',
          enabled: true,
          access: 'sk-ant-oat01-pending',
          refresh: 'pending-refresh',
          expires: Date.now() + 3_600_000,
        },
      ],
    },
    storagePath,
  )
  const paths = await resolveNativePoolPaths(storagePath)
  const held = gate()
  const arrived = gate()
  let intercepted = false
  const realOpen = filesystem.open
  const openSpy = spyOn(filesystem, 'open').mockImplementation(
    async (path, flags, mode) => {
      const file = await realOpen(path, flags, mode)
      if (isRuntimeStage(String(path), paths.runtime)) {
        const sync = file.sync.bind(file)
        file.sync = async () => {
          const staged = JSON.parse(await readFile(path, 'utf8'))
          if (!intercepted && staged.accounts.pending?.quotaErrorClearedAt) {
            intercepted = true
            arrived.open()
            await held.wait
          }
          return sync()
        }
      }
      return file
    },
  )
  deferCleanup(() => openSpy.mockRestore())
  const sent: Array<string | null> = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/api/oauth/usage'))
        return Response.json({
          five_hour: { utilization: 20 },
          seven_day: { utilization: 20 },
        })
      sent.push(new Headers(init?.headers).get('authorization'))
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      )
    },
    { preconnect: originalFetch.preconnect },
  )
  const model: Model<Api> = {
    id: 'claude-fable-5',
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
  const stream = streamCortexKitAnthropic(
    model,
    { messages: [{ role: 'user', content: 'hello', timestamp: 0 }], tools: [] },
    { apiKey: 'sk-ant-oat01-main-access', sessionId: 'pending-quota' },
  )
  const result = stream.result()
  trackDetached(result)
  await arrived.wait
  expect(
    await Promise.race([
      result.then((message) => message.stopReason),
      new Promise((resolve) =>
        setTimeout(() => resolve('blocked on sync'), 250),
      ),
    ]),
  ).toBe('stop')
  expect(sent).toEqual(['Bearer sk-ant-oat01-pending'])
  const view = await getPiNativeRuntime(storagePath).view()
  expect(
    view.accounts.find((row) => row.id === 'pending')?.quota?.five_hour
      ?.remainingPercent,
  ).toBe(80)
  let closed = false
  const closing = closePiNativeRuntime(storagePath).then(() => {
    closed = true
  })
  trackDetached(closing)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(closed).toBe(false)
  held.open()
  await closing
  expect(closed).toBe(true)
})
