/// <reference types="bun-types" />

import { describe, expect } from 'bun:test'
import { createNativeAccountRuntime, type NativeAccountSnapshot } from '@cortexkit/anthropic-auth-core'
import { readFile, stat } from 'node:fs/promises'
import { createTestLifetimeSuite } from '../../core/src/tests/test-lifetime.ts'
import { join } from 'node:path'
import { E2EHarness, type E2EHarnessOptions } from '../src/harness.ts'
import { FIXTURE_ADMITTED_ACCESS_TOKEN, FIXTURE_MAIN_ACCOUNT_UUID } from '../src/opencode-runner.ts'

const { test: it, deferCleanup, trackDetached, gate } = createTestLifetimeSuite()

async function createHarness(options: E2EHarnessOptions) {
  const harness = await E2EHarness.create(options)
  // A prompt timeout does not cancel the SDK transport. Abort at teardown,
  // then join the real request before disposing the child and its fixtures.
  const prompt = harness.client.session.prompt.bind(harness.client.session)
  harness.client.session.prompt = (options) => {
    let settled = false
    const stop = gate()
    const cancellation = stop.wait.then(async () => {
      if (!settled) await harness.abortSession(options.path.id)
    })
    trackDetached(cancellation)
    const work = prompt(options).finally(() => {
      settled = true
      stop.open()
    })
    trackDetached(work)
    return work
  }
  deferCleanup(() => harness.dispose())
  return harness
}

async function readQuotaState(harness: E2EHarness) {
  const native = harness.opencode.native
  if (!native) throw new Error('Quota fixture has no prepared native accounts')
  const runtime = createNativeAccountRuntime({
    paths: native.paths,
    host: 'opencode',
    vault: { env: {
      HOME: harness.opencode.env.homeDir,
      XDG_CONFIG_HOME: harness.opencode.env.configDir,
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
        harness.opencode.env.configDir, 'claustrum-enrollment.json',
      ),
    } },
  })
  try {
    return await runtime.read()
  } finally {
    runtime.close()
  }
}

function mainAccount(state: NativeAccountSnapshot) {
  expect(state.mode).toBe('local')
  const main = state.accounts.find((account) => account.id === 'main')
  if (!main) throw new Error('Quota fixture has no native main account')
  expect(main.source).toBe('local')
  expect(main.accountIdentity).toBe(FIXTURE_MAIN_ACCOUNT_UUID)
  expect(main.binding?.identity).toBe(FIXTURE_MAIN_ACCOUNT_UUID)
  return main
}

async function assertNativeHeaderQuota(harness: E2EHarness, state: NativeAccountSnapshot) {
  const main = mainAccount(state)
  expect(main.quota?.source).toBe('headers')
  expect(main.quota?.five_hour?.usedPercent).toBe(78)
  expect(main.quota?.seven_day?.usedPercent).toBe(40)
  expect(main.quota?.accountIdentity).toBe(FIXTURE_MAIN_ACCOUNT_UUID)
  const requests = harness.anthropic.requests()
    .filter((request) => request.body.model === 'claude-sonnet-4-5')
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.map((request) => request.headers.authorization))
    .toEqual(requests.map(() => `Bearer ${FIXTURE_ADMITTED_ACCESS_TOKEN}`))
  await assertPrivateMetadataBoundary(harness)
}

async function assertPrivateMetadataBoundary(harness: E2EHarness) {
  // A missing metadata file must fail rather than pass secret-exclusion checks.
  const metadata = await readFile(harness.opencode.native!.paths.runtime, 'utf8')
  expect(metadata).not.toContain('quotaToken')
  expect(metadata).not.toContain(FIXTURE_ADMITTED_ACCESS_TOKEN)
  expect(metadata).not.toContain('sk-ant-oat01-test-access-token')
  expect(metadata).not.toContain('test-refresh-token')
  // The owner-only runtime file deliberately stores the relay's private secret.
  // Public account/settings projections must not expose it or OAuth credentials.
  expect((await stat(harness.opencode.native!.paths.runtime)).mode & 0o777).toBe(0o600)
  const projection = JSON.stringify(await readQuotaState(harness))
  for (const secret of [FIXTURE_ADMITTED_ACCESS_TOKEN, 'sk-ant-oat01-test-access-token', 'test-refresh-token', 'relay-token'])
    expect(projection).not.toContain(secret)
}

async function waitForHeaderQuotaState(harness: E2EHarness) {
  let state: NativeAccountSnapshot | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await readQuotaState(harness)
    if (mainAccount(state).quota?.source === 'headers') return state
    await Bun.sleep(50)
  }
  throw new Error(
    `relay quota state did not persist: ${JSON.stringify(state)}\n--- stdout ---\n${harness.opencode.stdout()}\n--- stderr ---\n${harness.opencode.stderr()}`,
  )
}

const quotaHeaders = {
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-utilization': '0.78',
  'anthropic-ratelimit-unified-5h-reset': '1784246400',
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': '1784628000',
  'anthropic-ratelimit-unified-fallback': 'available',
}

describe('quota headers through relay', () => {
  it('harvests quota headers from a websocket relay response', async () => {
    const harness = await createHarness({ relay: 'websocket' })
    harness.script([
      {
        type: 'text',
        text: 'relay response',
        headers: quotaHeaders,
      },
    ])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitFor(() => (harness.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const state = await waitForHeaderQuotaState(harness)

    await assertNativeHeaderQuota(harness, state)
  }, 90_000)

  it('harvests quota headers from an HTTP relay response', async () => {
    const harness = await createHarness({ relay: 'http' })
    harness.script([{ type: 'text', text: 'http relay response', headers: quotaHeaders }])
    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the http relay response')
    await harness.waitFor(() => (harness.relay?.acceptedRequests() ?? 0) >= 1)
    await assertNativeHeaderQuota(harness, await waitForHeaderQuotaState(harness))
  }, 90_000)

  it('does not publish optimistic websocket headers before response_start', async () => {
    const harness = await createHarness({
      relay: 'websocket',
      relayResponseStartDelayMs: 250,
    })
    harness.script([{ type: 'text', text: 'delayed relay response', headers: quotaHeaders }])
    const sessionId = await harness.createSession()
    const prompt = harness.sendPrompt(sessionId, 'return the delayed relay response')
    trackDetached(prompt)
    await harness.waitFor(() => (harness.relay?.acceptedRequests() ?? 0) >= 1)
    await Bun.sleep(50)
    // The optimistic envelope has no quota-bearing headers. Only genuine
    // response_start headers may populate native metadata.
    expect(mainAccount(await readQuotaState(harness)).quota).toBeUndefined()
    await prompt
    await assertNativeHeaderQuota(harness, await waitForHeaderQuotaState(harness))
  }, 90_000)

  it('leaves quota state untouched when websocket relay headers have no quota data', async () => {
    const harness = await createHarness({ relay: 'websocket' })
    harness.script([{ type: 'text', text: 'relay response without quota' }])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitForSessionText(sessionId, 'relay response without quota')
    await harness.waitFor(() => (harness.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const state = await readQuotaState(harness)
    expect(mainAccount(state).quota).toBeUndefined()
    await assertPrivateMetadataBoundary(harness)
  }, 90_000)
})
