/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

type PersistedQuotaState = {
  main?: {
    quota?: {
      source?: string
      accountIdentity?: string
      five_hour?: { usedPercent?: number }
      seven_day?: { usedPercent?: number }
    }
    quotaToken?: string
  }
}

async function readQuotaState(harness: E2EHarness) {
  const statePath = join(
    harness.opencode.env.configDir,
    'anthropic-auth-state.json',
  )
  return readFile(statePath, 'utf8')
    .then((value) => JSON.parse(value) as PersistedQuotaState)
    .catch(() => null)
}

async function waitForHeaderQuotaState(harness: E2EHarness) {
  let state: PersistedQuotaState | null = null
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await readQuotaState(harness)
    if (state?.main?.quota?.source === 'headers') return state
    await Bun.sleep(50)
  }
  throw new Error(
    `relay quota state did not persist: ${JSON.stringify(state)}\n--- stdout ---\n${harness.opencode.stdout()}\n--- stderr ---\n${harness.opencode.stderr()}`,
  )
}

async function readFeedFiles(harness: E2EHarness) {
  try {
    const names = await readdir(harness.opencode.env.quotaFeedDir)
    return Promise.all(
            names.filter((name) => name.endsWith('.json')).map(async (name) =>
        readFile(join(harness.opencode.env.quotaFeedDir, name), 'utf8'),
      ),
    )
  } catch {
    return []
  }
}

async function waitForFeed(harness: E2EHarness) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const values = await readFeedFiles(harness)
    if (values.length === 1) return values
    await Bun.sleep(50)
  }
  throw new Error('quota feed record did not appear')
}

const quotaHeaders = {
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-5h-utilization': '0.78',
  'anthropic-ratelimit-unified-5h-reset': '1784246400',
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': '1784628000',
  'anthropic-ratelimit-unified-fallback': 'available',
}

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

describe('quota headers through relay', () => {
  it('harvests quota headers from a websocket relay response', async () => {
    harness = await E2EHarness.create({ relay: 'websocket', quotaFeed: true })
    harness.script([
      {
        type: 'text',
        text: 'relay response',
        headers: quotaHeaders,
      },
    ])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const state = await waitForHeaderQuotaState(harness)

    expect(state?.main?.quota?.source).toBe('headers')
    expect(state?.main?.quota?.five_hour?.usedPercent).toBe(78)
    expect(state?.main?.quota?.seven_day?.usedPercent).toBe(40)
    expect(state?.main?.quota?.accountIdentity).toEqual(expect.any(String))
    expect(state?.main?.quotaToken).toBeUndefined()
  }, 90_000)

  it('writes one equivalent schema-v3 feed record for an HTTP relay response', async () => {
    harness = await E2EHarness.create({ relay: 'http', quotaFeed: true })
    harness.script([{ type: 'text', text: 'http relay response', headers: quotaHeaders }])
    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the http relay response')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1)
    const files = await waitForFeed(harness)
    const record = JSON.parse(files[0]!)
    expect(record.version).toBe(3)
    expect(Object.values(record.entries)).toHaveLength(1)
    expect(Object.values(record.entries)[0]).toEqual(
      expect.objectContaining({ provider: 'anthropic', schema_version: 3 }),
    )
    expect(files[0]).not.toContain('authorization')
    expect(files[0]).not.toContain('access-token')
  }, 90_000)

  it('does not publish optimistic websocket headers before response_start', async () => {
    harness = await E2EHarness.create({
      relay: 'websocket',
      quotaFeed: true,
      relayResponseStartDelayMs: 250,
    })
    harness.script([{ type: 'text', text: 'delayed relay response', headers: quotaHeaders }])
    const sessionId = await harness.createSession()
    const prompt = harness.sendPrompt(sessionId, 'return the delayed relay response')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1)
    await Bun.sleep(50)
    // The optimistic envelope has no quota-bearing headers, so this pins that
    // guard; only genuine response_start headers are staged for publication.
    expect(await readFeedFiles(harness)).toHaveLength(0)
    await prompt
    const files = await waitForFeed(harness)
    expect(files).toHaveLength(1)
    const record = JSON.parse(files[0]!)
    expect(Object.values(record.entries)).toHaveLength(1)
    expect(Object.values(record.entries)[0]).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        schema_version: 3,
        quota: expect.objectContaining({
          five_hour: expect.objectContaining({ usedPercent: 78 }),
        }),
      }),
    )
  }, 90_000)

  it('leaves quota state untouched when websocket relay headers have no quota data', async () => {
    harness = await E2EHarness.create({ relay: 'websocket', quotaFeed: true })
    harness.script([{ type: 'text', text: 'relay response without quota' }])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitForSessionText(sessionId, 'relay response without quota')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const state = await readQuotaState(harness)
    expect(state?.main?.quota).toBeUndefined()
    expect(state?.main?.quotaToken).toBeUndefined()
  }, 90_000)
})
