import { afterEach, expect, mock } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { authorize, exchange } from '@cortexkit/anthropic-auth-core'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { addApiRoute, login, relaySetup } from '../cli.ts'

const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_AUTH_CONTENT',
] as const
const cancellations = new Set<AbortController>()
let teardownRequested = false
afterEach(() => {
  teardownRequested = true
  const closing = [...cancellations]
  for (const controller of closing) controller.abort()
})
const lifetimes = createTestLifetimeSuite()
function test(name: string, body: () => unknown, timeout?: number) {
  lifetimes.test(
    name,
    async () => {
      teardownRequested = false
      await setupBody()
      return body()
    },
    timeout,
  )
}
const originalFetch = globalThis.fetch
let directory: string
let path: string
let originalBytes: string
const prompt = mock(async (_question: string) => 'synthetic-answer')
const authorizeImpl = mock(
  async (): Promise<Awaited<ReturnType<typeof authorize>>> => ({
    url: 'https://example.test/sign-in',
    verifier: 'synthetic-verifier',
    state: 'synthetic-state',
    redirectUri: 'https://example.test/callback',
  }),
)
const exchangeImpl = mock(
  async (): Promise<Awaited<ReturnType<typeof exchange>>> => ({
    type: 'failed',
  }),
)
const network = mock(async (): Promise<Response> => {
  throw new Error('Unexpected external request in native CLI refusal test')
})

async function setupBody() {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const controller = new AbortController()
  cancellations.add(controller)
  if (teardownRequested) controller.abort()
  const ownedDirectory = await mkdtemp(join(tmpdir(), 'oc1-native-cli-'))
  directory = ownedDirectory
  lifetimes.deferCleanup(async () => {
    // TestLifetime waits for the test and its registered background reads
    // before deleting that test's directory or restoring its environment.
    controller.abort()
    try {
      await rm(ownedDirectory, { recursive: true, force: true })
    } finally {
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      cancellations.delete(controller)
    }
  })
  path = join(directory, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = path
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    directory,
    'anthropic-auth-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    directory,
    'enrollment.json',
  )
  delete process.env.OPENCODE_AUTH_CONTENT
  originalBytes = JSON.stringify({
    version: 1,
    accounts: [
      {
        id: 'legacy',
        type: 'oauth',
        access: 'synthetic-legacy-access-canary',
        refresh: 'synthetic-legacy-refresh-canary',
        expires: Date.now() + 60_000,
      },
    ],
  })
  await writeFile(path, originalBytes, { mode: 0o600 })
  prompt.mockClear()
  network.mockClear()
  authorizeImpl.mockClear()
  exchangeImpl.mockClear()
  globalThis.fetch = Object.assign(
    async () => {
      controller.signal.throwIfAborted()
      return network()
    },
    { preconnect: originalFetch.preconnect },
  )
}

async function expectNoMutationOrExternalWork() {
  expect(await readFile(path, 'utf8')).toBe(originalBytes)
  expect(await readdir(directory)).toEqual(['anthropic-auth.json'])
  expect(prompt).not.toHaveBeenCalled()
  expect(authorizeImpl).not.toHaveBeenCalled()
  expect(exchangeImpl).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
}

test('CLI OAuth login refuses an unmigrated store before prompting or creating the sign-in URL', async () => {
  await expect(
    login('synthetic-label', {
      prompt,
      authorize: authorizeImpl,
      exchange: exchangeImpl,
    }),
  ).rejects.toThrow('migration')
  await expectNoMutationOrExternalWork()
})

test('CLI API route add refuses an unmigrated store before collecting any credential', async () => {
  await expect(addApiRoute('synthetic-label', { prompt })).rejects.toThrow(
    'migration',
  )
  await expectNoMutationOrExternalWork()
})

test('CLI relay setup refuses an unmigrated store before Cloudflare provisioning', async () => {
  await expect(relaySetup({ prompt })).rejects.toThrow('migration')
  await expectNoMutationOrExternalWork()
})

test('supervised auth content refuses CLI OAuth login without replacing host or legacy auth', async () => {
  process.env.OPENCODE_AUTH_CONTENT = '{}'
  await expect(
    login('synthetic-label', {
      prompt,
      authorize: authorizeImpl,
      exchange: exchangeImpl,
    }),
  ).rejects.toThrow('OPENCODE_AUTH_CONTENT')
  await expectNoMutationOrExternalWork()
})

test('supervised auth content refuses native API route and relay mutations', async () => {
  process.env.OPENCODE_AUTH_CONTENT = '{}'
  await expect(addApiRoute('synthetic-label', { prompt })).rejects.toThrow(
    'OPENCODE_AUTH_CONTENT',
  )
  await expect(relaySetup({ prompt })).rejects.toThrow('OPENCODE_AUTH_CONTENT')
  await expectNoMutationOrExternalWork()
})

test('native CLI suite lifetime joins final fixture reads before restoring body environment', async () => {
  const ownedPath = path
  const expectedBytes = originalBytes
  const savedAccountPath = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  const readGate = lifetimes.gate()
  let completed = false
  lifetimes.trackDetached(
    (async () => {
      await readGate.wait
      expect(process.env.OPENCODE_ANTHROPIC_AUTH_FILE).toBe(savedAccountPath)
      expect(await readFile(ownedPath, 'utf8')).toBe(expectedBytes)
      completed = true
    })(),
  )
  lifetimes.deferCleanup(() => {
    expect(completed).toBe(true)
  })
  readGate.open()
})
